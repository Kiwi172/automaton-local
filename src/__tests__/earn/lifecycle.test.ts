/**
 * Job lifecycle, payment attribution, and spending limits.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  createJob,
  deliverJob,
  getEarnings,
  getJob,
  initJobStore,
  listJobs,
  markPaid,
  quoteJob,
} from "../../earn/jobs.js";
import { reconcilePayments, DEFAULT_PAYMENT_POLICY } from "../../earn/payments.js";
import {
  initSpendingLedger,
  refundJob,
  resolveSpendingPolicy,
  sendPayment,
} from "../../earn/spending.js";
import { initTaintStore } from "../../earn/taint.js";
import { parseXmr, formatXmr } from "../../local/monero/wallet-rpc.js";

const CUSTOMER =
  "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";

let db: BetterSqlite3.Database;
beforeEach(() => {
  db = new Database(":memory:");
  initJobStore(db);
  initTaintStore(db);
  initSpendingLedger(db);
});

function fakeWallet(options: {
  transfersBySubaddress?: Record<number, { amount: bigint; confirmations: number }[]>;
  unlocked?: bigint;
  onTransfer?: (address: string, amount: bigint) => void;
} = {}) {
  return {
    refresh: async () => {},
    getBalance: async () => ({
      balancePiconero: options.unlocked ?? parseXmr("10"),
      unlockedPiconero: options.unlocked ?? parseXmr("10"),
      blocksToUnlock: 0,
    }),
    createSubaddress: async (label: string) => ({ address: `sub-for-${label}`, index: 7 }),
    getIncomingTransfers: async (_min: number, index?: number) => {
      const list = options.transfersBySubaddress?.[index ?? -1] ?? [];
      return list.map((t, i) => ({
        txHash: `tx${i}`,
        amountPiconero: t.amount,
        height: 100,
        timestamp: 0,
        subaddressIndex: index,
        confirmations: t.confirmations,
      }));
    },
    transfer: async (p: { address: string; amountPiconero: bigint }) => {
      options.onTransfer?.(p.address, p.amountPiconero);
      return { txHash: "sent-tx", amountPiconero: p.amountPiconero, feePiconero: parseXmr("0.0001") };
    },
  } as any;
}

describe("payment attribution", () => {
  it("marks a job paid when its own subaddress receives the quote", async () => {
    const job = createJob(db, { request: "Summarise the news each morning." });
    quoteJob(db, job.id, { pricePiconero: parseXmr("0.01"), address: "sub", subaddressIndex: 7 });

    const rpc = fakeWallet({
      transfersBySubaddress: { 7: [{ amount: parseXmr("0.01"), confirmations: 0 }] },
    });
    const result = await reconcilePayments(rpc, db);

    expect(result.newlyPaid).toHaveLength(1);
    expect(getJob(db, job.id)!.status).toBe("paid");
  });

  it("does not credit a job from another job's subaddress", async () => {
    const job = createJob(db, { request: "Summarise the news each morning." });
    quoteJob(db, job.id, { pricePiconero: parseXmr("0.01"), address: "sub", subaddressIndex: 7 });

    // Money landed on a different subaddress entirely.
    const rpc = fakeWallet({
      transfersBySubaddress: { 9: [{ amount: parseXmr("5"), confirmations: 20 }] },
    });
    await reconcilePayments(rpc, db);
    expect(getJob(db, job.id)!.status).toBe("quoted");
  });

  it("tolerates a slightly short payment rather than looking like theft", async () => {
    const job = createJob(db, { request: "Summarise the news each morning." });
    quoteJob(db, job.id, { pricePiconero: parseXmr("0.01"), address: "sub", subaddressIndex: 7 });

    const rpc = fakeWallet({
      transfersBySubaddress: { 7: [{ amount: parseXmr("0.0099"), confirmations: 0 }] },
    });
    await reconcilePayments(rpc, db);
    expect(getJob(db, job.id)!.status).toBe("paid");
  });

  it("does not accept a materially short payment", async () => {
    const job = createJob(db, { request: "Summarise the news each morning." });
    quoteJob(db, job.id, { pricePiconero: parseXmr("1"), address: "sub", subaddressIndex: 7 });

    const rpc = fakeWallet({
      transfersBySubaddress: { 7: [{ amount: parseXmr("0.1"), confirmations: 20 }] },
    });
    await reconcilePayments(rpc, db);
    expect(getJob(db, job.id)!.status).toBe("quoted");
  });

  it("holds a large unconfirmed payment until it confirms", async () => {
    const job = createJob(db, { request: "Do a big piece of work please." });
    quoteJob(db, job.id, { pricePiconero: parseXmr("2"), address: "sub", subaddressIndex: 7 });

    const rpc = fakeWallet({
      transfersBySubaddress: { 7: [{ amount: parseXmr("2"), confirmations: 1 }] },
    });
    await reconcilePayments(rpc, db);
    // Above the trust threshold and not yet confirmed — work must not start.
    expect(getJob(db, job.id)!.status).toBe("quoted");

    const confirmed = fakeWallet({
      transfersBySubaddress: {
        7: [{ amount: parseXmr("2"), confirmations: DEFAULT_PAYMENT_POLICY.requiredConfirmations }],
      },
    });
    await reconcilePayments(confirmed, db);
    expect(getJob(db, job.id)!.status).toBe("paid");
  });

  it("expires a quote nobody paid", async () => {
    const job = createJob(db, { request: "Summarise the news each morning." });
    quoteJob(db, job.id, { pricePiconero: parseXmr("0.01"), address: "sub", subaddressIndex: 7 });
    db.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 48 * 3_600_000).toISOString(),
      job.id,
    );

    const result = await reconcilePayments(fakeWallet(), db);
    expect(result.expired).toHaveLength(1);
    expect(getJob(db, job.id)!.status).toBe("expired");
  });
});

describe("earnings", () => {
  it("counts only delivered work as earned", () => {
    const a = createJob(db, { request: "Job one please do it." });
    const b = createJob(db, { request: "Job two please do it." });
    markPaid(db, a.id, { amountPiconero: parseXmr("0.5"), txHash: "t1" });
    markPaid(db, b.id, { amountPiconero: parseXmr("0.3"), txHash: "t2" });
    deliverJob(db, a.id, "here you go");

    const earnings = getEarnings(db);
    expect(formatXmr(earnings.deliveredPiconero)).toBe("0.5");
    expect(formatXmr(earnings.awaitingWorkPiconero)).toBe("0.3");
  });
});

describe("refunds", () => {
  it("returns money only to the address given at submission", async () => {
    let sentTo = "";
    const job = createJob(db, {
      request: "Please do this thing for me.",
      refundAddress: CUSTOMER,
    });
    markPaid(db, job.id, { amountPiconero: parseXmr("0.2"), txHash: "t" });

    const outcome = await refundJob({
      rpc: fakeWallet({ onTransfer: (addr) => { sentTo = addr; } }),
      db,
      policy: resolveSpendingPolicy(),
      jobId: job.id,
      reason: "could not do it",
    });

    expect(outcome.status).toBe("sent");
    expect(sentTo).toBe(CUSTOMER);
    expect(getJob(db, job.id)!.status).toBe("refunded");
  });

  it("refunds exactly what was paid, never more", async () => {
    let sentAmount = 0n;
    const job = createJob(db, { request: "Do this thing.", refundAddress: CUSTOMER });
    markPaid(db, job.id, { amountPiconero: parseXmr("0.05"), txHash: "t" });

    await refundJob({
      rpc: fakeWallet({ onTransfer: (_a, amt) => { sentAmount = amt; } }),
      db,
      policy: resolveSpendingPolicy(),
      jobId: job.id,
      reason: "x",
    });
    expect(formatXmr(sentAmount)).toBe("0.05");
  });

  it("cannot refund a job that was never paid", async () => {
    const job = createJob(db, { request: "Do this thing.", refundAddress: CUSTOMER });
    const outcome = await refundJob({
      rpc: fakeWallet(),
      db,
      policy: resolveSpendingPolicy(),
      jobId: job.id,
      reason: "x",
    });
    expect(outcome.status).toBe("refused");
  });
});

describe("spending limits", () => {
  const policy = () => ({ ...resolveSpendingPolicy(), cooldownMs: 0 });

  it("refuses an amount over the per-payment cap", async () => {
    const outcome = await sendPayment({
      rpc: fakeWallet(),
      db,
      policy: { ...policy(), maxPerTransactionPiconero: parseXmr("0.1") },
      toAddress: CUSTOMER,
      amountPiconero: parseXmr("1"),
      reason: "buying something",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/per-payment limit/i);
  });

  it("refuses to spend into the reserve", async () => {
    const outcome = await sendPayment({
      rpc: fakeWallet({ unlocked: parseXmr("0.2") }),
      db,
      policy: { ...policy(), reservePiconero: parseXmr("0.15") },
      toAddress: CUSTOMER,
      amountPiconero: parseXmr("0.1"),
      reason: "buying something",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/reserve/i);
  });

  it("refuses an invalid destination before touching the wallet", async () => {
    const outcome = await sendPayment({
      rpc: fakeWallet(),
      db,
      policy: policy(),
      toAddress: "not-an-address",
      amountPiconero: parseXmr("0.01"),
      reason: "x",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/not a valid monero address/i);
  });

  it("honours an operator allowlist", async () => {
    const outcome = await sendPayment({
      rpc: fakeWallet(),
      db,
      policy: { ...policy(), allowedDestinations: ["some-other-address"] },
      toAddress: CUSTOMER,
      amountPiconero: parseXmr("0.01"),
      reason: "x",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/allowlist/i);
  });
});
