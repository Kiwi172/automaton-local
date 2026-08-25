/**
 * Watching for Payment
 *
 * Reconciles incoming Monero against quoted jobs. A job's subaddress is its
 * invoice, so matching a payment to a job is a lookup rather than a guess.
 *
 * The judgement call here is when to call a job paid. Monero transactions
 * appear in the pool within seconds but take ~20 minutes to confirm, and
 * waiting for confirmations before starting work means every customer waits
 * twenty minutes to see anything happen. So the rule scales with the amount:
 * small jobs start on an unconfirmed payment, larger ones wait. The threshold
 * is the operator's to set, because it is a bet on how much work is worth
 * risking to a double-spend.
 */

import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import { MoneroWalletRpc, formatXmr, parseXmr } from "../local/monero/wallet-rpc.js";
import { findJobBySubaddress, markPaid, setStatus, listJobs, type Job } from "./jobs.js";

const logger = createLogger("payments");

export interface PaymentPolicy {
  /** At or below this, unconfirmed payments are accepted. */
  trustUnconfirmedBelowPiconero: bigint;
  /** Confirmations required above that threshold. */
  requiredConfirmations: number;
  /** A quote not paid within this window expires. */
  quoteTtlMs: number;
  /** Accept a payment this fraction short of the quote (fees, rounding). */
  underpaymentTolerance: number;
}

export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = {
  trustUnconfirmedBelowPiconero: parseXmr("0.05"),
  requiredConfirmations: 10,
  quoteTtlMs: 24 * 60 * 60 * 1000,
  underpaymentTolerance: 0.02,
};

export interface ReconcileResult {
  newlyPaid: Job[];
  expired: Job[];
}

/**
 * Check quoted jobs for payment and expire stale quotes.
 *
 * Called from the heartbeat, so a customer paying while the agent sleeps still
 * has their job picked up rather than sitting until the agent happens to look.
 */
export async function reconcilePayments(
  rpc: MoneroWalletRpc,
  db: BetterSqlite3.Database,
  policy: PaymentPolicy = DEFAULT_PAYMENT_POLICY,
): Promise<ReconcileResult> {
  const quoted = listJobs(db, { status: "quoted", limit: 200 });
  const result: ReconcileResult = { newlyPaid: [], expired: [] };
  if (quoted.length === 0) return result;

  await rpc.refresh();

  for (const job of quoted) {
    if (job.paymentSubaddressIndex === null || job.pricePiconero === null) continue;

    const transfers = await rpc
      .getIncomingTransfers(0, job.paymentSubaddressIndex)
      .catch(() => []);

    const received = transfers.reduce((sum, t) => sum + t.amountPiconero, 0n);
    if (received > 0n) {
      // Accept slightly short payments; a customer who fumbled the fee by a
      // rounding error has still obviously paid, and refusing looks like theft.
      const minimum =
        job.pricePiconero -
        (job.pricePiconero * BigInt(Math.round(policy.underpaymentTolerance * 10_000))) / 10_000n;

      if (received >= minimum) {
        const confirmations = Math.min(...transfers.map((t) => t.confirmations ?? 0));
        const needsConfirmation = received > policy.trustUnconfirmedBelowPiconero;

        if (!needsConfirmation || confirmations >= policy.requiredConfirmations) {
          markPaid(db, job.id, {
            amountPiconero: received,
            txHash: transfers[0]?.txHash ?? "",
          });
          result.newlyPaid.push({ ...job, status: "paid", paidPiconero: received });
          continue;
        }

        logger.info(
          `Job ${job.id}: ${formatXmr(received)} XMR seen, holding for ${policy.requiredConfirmations} confirmations (have ${confirmations})`,
        );
        continue;
      }

      logger.info(
        `Job ${job.id}: underpaid — ${formatXmr(received)} of ${formatXmr(job.pricePiconero)} XMR`,
      );
      continue;
    }

    // Nothing received. Expire the quote once it is stale, so the job list does
    // not fill with offers nobody ever took up.
    const age = Date.now() - new Date(job.updatedAt).getTime();
    if (age > policy.quoteTtlMs) {
      setStatus(db, job.id, "expired", "Quote expired without payment.");
      result.expired.push({ ...job, status: "expired" });
    }
  }

  if (result.newlyPaid.length > 0) {
    logger.info(`${result.newlyPaid.length} job(s) newly paid`);
  }
  return result;
}
