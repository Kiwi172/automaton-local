/**
 * Outgoing Payments
 *
 * The agent can send Monero to addresses it chooses. That is the sovereignty
 * the operator asked for, and it removes the property that made donations
 * injection-proof: a donation cannot be redirected because its destination is a
 * constant in config, whereas this takes a destination as an argument.
 *
 * So the defences here are different in kind. They do not try to decide whether
 * a payment is a good idea — the agent decides that. They bound the damage:
 *
 * - Caps per transaction and per day, in code, that no instruction can raise.
 * - A reserve the balance is never spent below.
 * - Every send audited, with the reason the agent gave.
 * - Refunds are a separate path that can only pay the address the customer
 *   supplied when they submitted the job, so the common case of returning money
 *   keeps the donation system's structural guarantee.
 * - An optional allowlist, for operators who want arbitrary sends off entirely.
 *
 * What none of this can do is stop the agent being talked into a bad payment
 * within its limits. That risk is inherent to the choice, and the prompt is
 * explicit that instructions arriving inside job requests are not authority to
 * pay anyone.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import { validateMoneroAddress } from "../local/monero/address.js";
import { MoneroWalletRpc, formatXmr, parseXmr } from "../local/monero/wallet-rpc.js";
import { getJob, setStatus } from "./jobs.js";
import { describeRefusal } from "./taint.js";

const logger = createLogger("spending");

export interface SpendingPolicy {
  maxPerTransactionPiconero: bigint;
  maxPerDayPiconero: bigint;
  /** Never spend the balance below this. */
  reservePiconero: bigint;
  cooldownMs: number;
  /** When non-empty, only these destinations are permitted. */
  allowedDestinations: string[];
  /** Master switch for arbitrary sends. Refunds are unaffected. */
  arbitrarySendsEnabled: boolean;
}

export function resolveSpendingPolicy(): SpendingPolicy {
  const xmr = (name: string, fallback: string): bigint => {
    const raw = process.env[name];
    if (!raw?.trim()) return parseXmr(fallback);
    try {
      return parseXmr(raw);
    } catch {
      return parseXmr(fallback);
    }
  };
  const list = (process.env.AUTOMATON_XMR_ALLOWED_DESTINATIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    maxPerTransactionPiconero: xmr("AUTOMATON_XMR_MAX_PER_TX", "0.5"),
    maxPerDayPiconero: xmr("AUTOMATON_XMR_MAX_PER_DAY", "2"),
    reservePiconero: xmr("AUTOMATON_XMR_RESERVE", "0"),
    cooldownMs: Number(process.env.AUTOMATON_XMR_COOLDOWN_SECONDS || 60) * 1000,
    allowedDestinations: list,
    arbitrarySendsEnabled:
      (process.env.AUTOMATON_XMR_ARBITRARY_SENDS || "1").trim().toLowerCase() !== "0",
  };
}

export type SendPurpose = "refund" | "payment";

export type SendOutcome =
  | { status: "sent"; txHash: string; amountPiconero: bigint; feePiconero: bigint }
  | { status: "refused"; reason: string };

export function initSpendingLedger(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outgoing_payments (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      purpose TEXT NOT NULL,
      to_address TEXT NOT NULL,
      amount_piconero TEXT NOT NULL,
      fee_piconero TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      reason TEXT,
      job_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outgoing_created ON outgoing_payments(created_at DESC);
  `);
}

function spentSince(db: BetterSqlite3.Database, since: Date): bigint {
  const rows = db
    .prepare(`SELECT amount_piconero FROM outgoing_payments WHERE created_at >= ?`)
    .all(since.toISOString()) as { amount_piconero: string }[];
  return rows.reduce((sum, r) => sum + BigInt(r.amount_piconero), 0n);
}

function lastSendAt(db: BetterSqlite3.Database): Date | null {
  const row = db
    .prepare(`SELECT created_at FROM outgoing_payments ORDER BY created_at DESC LIMIT 1`)
    .get() as { created_at: string } | undefined;
  return row ? new Date(row.created_at) : null;
}

async function send(params: {
  rpc: MoneroWalletRpc;
  db: BetterSqlite3.Database;
  policy: SpendingPolicy;
  toAddress: string;
  amountPiconero: bigint;
  purpose: SendPurpose;
  reason: string;
  jobId?: string;
  /** Refunds bypass the allowlist and the arbitrary-send switch. */
  bypassDestinationChecks?: boolean;
}): Promise<SendOutcome> {
  const { rpc, db, policy } = params;

  if (params.amountPiconero <= 0n) {
    return { status: "refused", reason: "Amount must be positive." };
  }

  const check = validateMoneroAddress(params.toAddress);
  if (!check.valid) {
    return {
      status: "refused",
      reason: `That is not a valid Monero address: ${check.reason}. Nothing was sent.`,
    };
  }

  if (!params.bypassDestinationChecks) {
    // The structural defence. Any address that arrived inside untrusted text is
    // unpayable, regardless of how convincing the surrounding words were —
    // detection cannot be trusted to recognise the persuasion, but it does not
    // need to when the destination itself is disqualified by having been asked for.
    const refusal = describeRefusal(db, params.toAddress);
    if (refusal) {
      logger.warn(`Refused payment to tainted address ${params.toAddress.slice(0, 12)}…`);
      return { status: "refused", reason: refusal };
    }

    if (!policy.arbitrarySendsEnabled) {
      return {
        status: "refused",
        reason:
          "Arbitrary payments are disabled by your creator. You can still refund customers.",
      };
    }
    if (
      policy.allowedDestinations.length > 0 &&
      !policy.allowedDestinations.includes(params.toAddress)
    ) {
      return {
        status: "refused",
        reason:
          "That address is not on your creator's allowlist. This is a configuration limit, " +
          "not something to work around.",
      };
    }
  }

  if (params.amountPiconero > policy.maxPerTransactionPiconero) {
    return {
      status: "refused",
      reason:
        `${formatXmr(params.amountPiconero)} XMR exceeds the ${formatXmr(policy.maxPerTransactionPiconero)} XMR ` +
        `per-payment limit.`,
    };
  }

  const last = lastSendAt(db);
  if (last && Date.now() - last.getTime() < policy.cooldownMs) {
    return {
      status: "refused",
      reason: `Payment cooldown active since ${last.toISOString()}. Wait before sending again.`,
    };
  }

  const spentToday = spentSince(db, new Date(Date.now() - 24 * 3_600_000));
  if (spentToday + params.amountPiconero > policy.maxPerDayPiconero) {
    return {
      status: "refused",
      reason:
        `This would put today's outgoing total at ${formatXmr(spentToday + params.amountPiconero)} XMR, ` +
        `over the ${formatXmr(policy.maxPerDayPiconero)} XMR daily limit.`,
    };
  }

  const balance = await rpc.getBalance();
  const spendable = balance.unlockedPiconero - policy.reservePiconero;
  if (params.amountPiconero > spendable) {
    return {
      status: "refused",
      reason:
        `Only ${formatXmr(spendable > 0n ? spendable : 0n)} XMR is spendable above your ` +
        `${formatXmr(policy.reservePiconero)} XMR reserve.`,
    };
  }

  let transfer;
  try {
    transfer = await rpc.transfer({
      address: params.toAddress,
      amountPiconero: params.amountPiconero,
    });
  } catch (err: any) {
    return { status: "refused", reason: `The wallet refused the transfer: ${err.message}` };
  }

  db.prepare(
    `INSERT INTO outgoing_payments
       (id, created_at, purpose, to_address, amount_piconero, fee_piconero, tx_hash, reason, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    new Date().toISOString(),
    params.purpose,
    params.toAddress,
    transfer.amountPiconero.toString(),
    transfer.feePiconero.toString(),
    transfer.txHash,
    params.reason,
    params.jobId ?? null,
  );

  logger.info(
    `Sent ${formatXmr(transfer.amountPiconero)} XMR (${params.purpose}) — tx ${transfer.txHash}`,
  );

  return {
    status: "sent",
    txHash: transfer.txHash,
    amountPiconero: transfer.amountPiconero,
    feePiconero: transfer.feePiconero,
  };
}

/** Pay an address the agent chose. Subject to every limit above. */
export async function sendPayment(params: {
  rpc: MoneroWalletRpc;
  db: BetterSqlite3.Database;
  policy: SpendingPolicy;
  toAddress: string;
  amountPiconero: bigint;
  reason: string;
}): Promise<SendOutcome> {
  return send({ ...params, purpose: "payment" });
}

/**
 * Return a customer's money.
 *
 * The destination is not an argument: it is the refund address recorded when
 * the job was submitted. So the structural guarantee that protects donations
 * also protects the refund path — no later instruction can point it elsewhere.
 */
export async function refundJob(params: {
  rpc: MoneroWalletRpc;
  db: BetterSqlite3.Database;
  policy: SpendingPolicy;
  jobId: string;
  reason: string;
}): Promise<SendOutcome> {
  const job = getJob(params.db, params.jobId);
  if (!job) return { status: "refused", reason: `No job ${params.jobId}.` };
  if (job.paidPiconero <= 0n) {
    return { status: "refused", reason: `Job ${params.jobId} was never paid; nothing to refund.` };
  }
  if (!job.refundAddress) {
    return {
      status: "refused",
      reason:
        `Job ${params.jobId} has no refund address — the customer did not supply one. ` +
        `Ask them for one through whatever contact they left.`,
    };
  }

  const outcome = await send({
    rpc: params.rpc,
    db: params.db,
    policy: params.policy,
    toAddress: job.refundAddress,
    amountPiconero: job.paidPiconero,
    purpose: "refund",
    reason: params.reason,
    jobId: job.id,
    bypassDestinationChecks: true,
  });

  if (outcome.status === "sent") {
    setStatus(params.db, job.id, "refunded", params.reason);
  }
  return outcome;
}

export function getOutgoingHistory(
  db: BetterSqlite3.Database,
  limit = 20,
): {
  createdAt: string;
  purpose: string;
  toAddress: string;
  amountPiconero: bigint;
  reason: string | null;
  txHash: string;
}[] {
  const rows = db
    .prepare(
      `SELECT created_at, purpose, to_address, amount_piconero, reason, tx_hash
       FROM outgoing_payments ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
  return rows.map((r) => ({
    createdAt: r.created_at,
    purpose: r.purpose,
    toAddress: r.to_address,
    amountPiconero: BigInt(r.amount_piconero),
    reason: r.reason,
    txHash: r.tx_hash,
  }));
}
