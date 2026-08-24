/**
 * Creator Donations
 *
 * The agent gives a share of what it earns back to its creator, in Monero.
 *
 * The rules live here rather than in the prompt, because a prompt is a
 * suggestion and this is money. Specifically:
 *
 * - The destination is always the creator address from config. The agent picks
 *   how much, never who. No tool argument, skill, inbox message or web page can
 *   redirect a donation, so prompt injection cannot turn this into an exfil
 *   channel.
 * - "Income" is measured from the wallet's own incoming transfers since the last
 *   donation checkpoint, not from the agent's account of what it earned.
 * - Every caller-supplied share is clamped to the operator's min/max, and every
 *   amount is clamped by per-transaction, per-day and reserve limits.
 * - The reserve is never spent. An agent that donates itself down to zero
 *   cannot pay for the next thing it needs.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../../observability/logger.js";
import {
  formatXmr,
  MoneroWalletRpc,
  type MoneroTransfer,
} from "./wallet-rpc.js";

const logger = createLogger("donations");

const CHECKPOINT_KEY = "monero_donation_checkpoint_height";

export interface DonationPolicy {
  /** Locked destination. The agent cannot choose or change this. */
  creatorAddress: string;
  /** Share used when the agent does not name one. */
  defaultSharePercent: number;
  /** Operator bounds on what the agent may choose. */
  minSharePercent: number;
  maxSharePercent: number;
  /** Below this, a donation is not worth its own fee — skip and accumulate. */
  minDonationPiconero: bigint;
  maxDonationPerTxPiconero: bigint;
  maxDonationPerDayPiconero: bigint;
  /** Never spend the balance below this. */
  reservePiconero: bigint;
  cooldownMs: number;
}

export interface DonationRecord {
  id: string;
  createdAt: string;
  amountPiconero: bigint;
  feePiconero: bigint;
  sharePercent: number;
  incomeBasisPiconero: bigint;
  txHash: string;
  note: string | null;
}

export type DonationOutcome =
  | { status: "sent"; record: DonationRecord }
  | { status: "skipped"; reason: string };

/**
 * Ledger table. Created on demand rather than through the shared schema
 * migration chain, so this fork stays easy to rebase onto upstream.
 */
export function initDonationLedger(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monero_donations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      amount_piconero TEXT NOT NULL,
      fee_piconero TEXT NOT NULL,
      share_percent REAL NOT NULL,
      income_basis_piconero TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_monero_donations_created
      ON monero_donations(created_at DESC);
  `);
}

export function getDonationHistory(
  db: BetterSqlite3.Database,
  limit = 20,
): DonationRecord[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, amount_piconero, fee_piconero, share_percent,
              income_basis_piconero, tx_hash, note
       FROM monero_donations ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    amountPiconero: BigInt(r.amount_piconero),
    feePiconero: BigInt(r.fee_piconero),
    sharePercent: r.share_percent,
    incomeBasisPiconero: BigInt(r.income_basis_piconero),
    txHash: r.tx_hash,
    note: r.note ?? null,
  }));
}

function getDonatedSince(db: BetterSqlite3.Database, since: Date): bigint {
  const rows = db
    .prepare(`SELECT amount_piconero FROM monero_donations WHERE created_at >= ?`)
    .all(since.toISOString()) as { amount_piconero: string }[];
  return rows.reduce((sum, r) => sum + BigInt(r.amount_piconero), 0n);
}

function getLastDonationAt(db: BetterSqlite3.Database): Date | null {
  const row = db
    .prepare(`SELECT created_at FROM monero_donations ORDER BY created_at DESC LIMIT 1`)
    .get() as { created_at: string } | undefined;
  return row ? new Date(row.created_at) : null;
}

function getCheckpointHeight(db: BetterSqlite3.Database): number {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(CHECKPOINT_KEY) as
    | { value: string }
    | undefined;
  const parsed = row ? Number(row.value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function setCheckpointHeight(db: BetterSqlite3.Database, height: number): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(CHECKPOINT_KEY, String(height), new Date().toISOString());
}

export interface IncomeSummary {
  /** Income received since the last donation checkpoint. */
  undonatedPiconero: bigint;
  transferCount: number;
  /** Highest block height seen, for advancing the checkpoint after a donation. */
  latestHeight: number;
}

/** Measure income the wallet actually received since the last donation. */
export async function measureUndonatedIncome(
  rpc: MoneroWalletRpc,
  db: BetterSqlite3.Database,
): Promise<IncomeSummary> {
  const checkpoint = getCheckpointHeight(db);
  const transfers = await rpc.getIncomingTransfers(checkpoint);
  // get_transfers is inclusive of min_height, so a transfer sitting exactly on
  // the checkpoint has already been counted.
  const fresh = transfers.filter((t) => t.height > checkpoint);
  return {
    undonatedPiconero: fresh.reduce((sum, t) => sum + t.amountPiconero, 0n),
    transferCount: fresh.length,
    latestHeight: fresh.reduce((max, t) => Math.max(max, t.height), checkpoint),
  };
}

function clampShare(policy: DonationPolicy, requested: number | undefined): number {
  const share = requested === undefined || !Number.isFinite(requested)
    ? policy.defaultSharePercent
    : requested;
  return Math.min(policy.maxSharePercent, Math.max(policy.minSharePercent, share));
}

/** Percentage of a BigInt, in basis points to avoid floating-point drift. */
function percentOf(amount: bigint, percent: number): bigint {
  const basisPoints = BigInt(Math.round(percent * 100));
  return (amount * basisPoints) / 10_000n;
}

/**
 * Donate a share of income to the creator.
 *
 * Returns a "skipped" outcome with a plain-language reason rather than throwing
 * for the ordinary cases (nothing earned yet, too small to be worth a fee, on
 * cooldown) — the agent reads these and moves on.
 */
export async function donateToCreator(params: {
  rpc: MoneroWalletRpc;
  db: BetterSqlite3.Database;
  policy: DonationPolicy;
  /** Share the agent chose; clamped to the operator's bounds. */
  sharePercent?: number;
  note?: string;
}): Promise<DonationOutcome> {
  const { rpc, db, policy } = params;

  if (!policy.creatorAddress) {
    return { status: "skipped", reason: "No creator Monero address is configured." };
  }

  const lastAt = getLastDonationAt(db);
  if (lastAt && Date.now() - lastAt.getTime() < policy.cooldownMs) {
    const waitMin = Math.ceil(
      (policy.cooldownMs - (Date.now() - lastAt.getTime())) / 60_000,
    );
    return {
      status: "skipped",
      reason: `Donation cooldown: last donation was ${lastAt.toISOString()}. Try again in ~${waitMin} min.`,
    };
  }

  await rpc.refresh();
  const income = await measureUndonatedIncome(rpc, db);
  if (income.undonatedPiconero <= 0n) {
    return {
      status: "skipped",
      reason: "No income received since the last donation. Nothing to share yet.",
    };
  }

  const share = clampShare(policy, params.sharePercent);
  let amount = percentOf(income.undonatedPiconero, share);

  // Per-transaction ceiling.
  if (amount > policy.maxDonationPerTxPiconero) {
    amount = policy.maxDonationPerTxPiconero;
  }

  // Daily ceiling.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const donatedToday = getDonatedSince(db, dayAgo);
  const dailyRemaining = policy.maxDonationPerDayPiconero - donatedToday;
  if (dailyRemaining <= 0n) {
    return {
      status: "skipped",
      reason: `Daily donation cap reached (${formatXmr(policy.maxDonationPerDayPiconero)} XMR/24h).`,
    };
  }
  if (amount > dailyRemaining) {
    amount = dailyRemaining;
  }

  // Reserve: the wallet must stay operable after the transfer, fee included.
  const balance = await rpc.getBalance();
  const spendable = balance.unlockedPiconero - policy.reservePiconero;
  if (spendable <= 0n) {
    return {
      status: "skipped",
      reason:
        `Unlocked balance ${formatXmr(balance.unlockedPiconero)} XMR is at or below the ` +
        `reserve of ${formatXmr(policy.reservePiconero)} XMR` +
        (balance.blocksToUnlock > 0
          ? `, and ${balance.blocksToUnlock} more blocks are needed to unlock the rest.`
          : "."),
    };
  }
  if (amount > spendable) {
    amount = spendable;
  }

  if (amount < policy.minDonationPiconero) {
    return {
      status: "skipped",
      reason:
        `Computed donation ${formatXmr(amount)} XMR is below the ${formatXmr(policy.minDonationPiconero)} XMR ` +
        `minimum — too small to be worth its own fee. It stays counted as income and rolls into the next one.`,
    };
  }

  let transfer: MoneroTransfer;
  try {
    transfer = await rpc.transfer({
      // Destination comes from config, never from the caller.
      address: policy.creatorAddress,
      amountPiconero: amount,
    });
  } catch (err: any) {
    // Checkpoint is deliberately not advanced: a failed donation must not
    // silently forgive the income it was meant to share.
    return { status: "skipped", reason: `Transfer failed: ${err.message}` };
  }

  const record: DonationRecord = {
    id: ulid(),
    createdAt: new Date().toISOString(),
    amountPiconero: transfer.amountPiconero,
    feePiconero: transfer.feePiconero,
    sharePercent: share,
    incomeBasisPiconero: income.undonatedPiconero,
    txHash: transfer.txHash,
    note: params.note ?? null,
  };

  db.prepare(
    `INSERT INTO monero_donations
       (id, created_at, amount_piconero, fee_piconero, share_percent,
        income_basis_piconero, tx_hash, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.createdAt,
    record.amountPiconero.toString(),
    record.feePiconero.toString(),
    record.sharePercent,
    record.incomeBasisPiconero.toString(),
    record.txHash,
    record.note,
  );

  setCheckpointHeight(db, income.latestHeight);

  logger.info(
    `Donated ${formatXmr(record.amountPiconero)} XMR (${share}% of ${formatXmr(income.undonatedPiconero)} XMR income) — tx ${record.txHash}`,
  );

  return { status: "sent", record };
}
