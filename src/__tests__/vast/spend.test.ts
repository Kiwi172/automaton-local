/**
 * Spend caps.
 *
 * These are the tests that stand between a looping agent and an unbounded GPU
 * bill. Local mode removed the credit-based survival pressure that would
 * otherwise stop a runaway, and Vast bills for as long as an instance exists,
 * so nothing else says no.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  checkBudget,
  getActiveRentals,
  getSpendSince,
  initVastLedger,
  recordRentalEnd,
  recordRentalStart,
} from "../../vast/spend.js";
import type { VastSpendLimits } from "../../vast/config.js";

const LIMITS: VastSpendLimits = {
  maxDollarsPerHour: 0.6,
  maxHourlySpend: 2,
  maxDailySpend: 10,
  maxConcurrentInstances: 1,
};

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new Database(":memory:");
  initVastLedger(db);
});

/** Backdate a rental so window arithmetic can be tested without waiting. */
function startRentalAt(instanceId: number, dph: number, hoursAgo: number, ended?: number) {
  recordRentalStart(db, { instanceId, purpose: "escalation", dollarsPerHour: dph });
  const started = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  db.prepare(`UPDATE vast_rentals SET started_at = ? WHERE instance_id = ?`).run(started, instanceId);
  if (ended !== undefined) {
    const endedAt = new Date(Date.now() - ended * 3_600_000).toISOString();
    const cost = (hoursAgo - ended) * dph;
    db.prepare(
      `UPDATE vast_rentals SET ended_at = ?, final_cost_dollars = ? WHERE instance_id = ?`,
    ).run(endedAt, cost, instanceId);
  }
}

describe("per-instance rate", () => {
  it("refuses a machine priced above the cap", () => {
    const verdict = checkBudget(db, LIMITS, 1.5);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("per-instance limit");
  });

  it("allows one at the cap", () => {
    expect(checkBudget(db, LIMITS, 0.6).allowed).toBe(true);
  });
});

describe("concurrency", () => {
  it("refuses a second instance when one is already running", () => {
    recordRentalStart(db, { instanceId: 1, purpose: "escalation", dollarsPerHour: 0.3 });
    const verdict = checkBudget(db, LIMITS, 0.3);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("already running");
  });

  it("allows again once the first is destroyed", () => {
    recordRentalStart(db, { instanceId: 1, purpose: "escalation", dollarsPerHour: 0.3 });
    recordRentalEnd(db, 1);
    expect(checkBudget(db, LIMITS, 0.3).allowed).toBe(true);
  });

  it("counts children against the same limit as escalation", () => {
    recordRentalStart(db, { instanceId: 1, purpose: "child", dollarsPerHour: 0.2 });
    expect(checkBudget(db, LIMITS, 0.2).allowed).toBe(false);
  });
});

describe("rolling windows", () => {
  it("counts a still-running rental at what it has accrued so far", () => {
    startRentalAt(1, 0.5, 2); // two hours in, never ended
    const daySpend = getSpendSince(db, new Date(Date.now() - 24 * 3_600_000));
    expect(daySpend).toBeGreaterThan(0.9);
    expect(daySpend).toBeLessThan(1.1);
  });

  it("only counts the part of a rental inside the window", () => {
    startRentalAt(1, 1.0, 10); // ten hours in, still running
    const hourSpend = getSpendSince(db, new Date(Date.now() - 3_600_000));
    // Only the last hour belongs to the hourly window, not all ten.
    expect(hourSpend).toBeLessThan(1.2);
  });

  it("refuses when the daily cap would be breached", () => {
    const limits = { ...LIMITS, maxConcurrentInstances: 10, maxDailySpend: 1 };
    startRentalAt(1, 0.5, 2, 0.5); // finished, ~0.75 spent
    const verdict = checkBudget(db, limits, 0.5);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("daily cap");
  });

  it("refuses when the hourly cap would be breached", () => {
    const limits = { ...LIMITS, maxConcurrentInstances: 10, maxHourlySpend: 0.5 };
    startRentalAt(1, 0.4, 1, 0); // a full hour at 0.4
    const verdict = checkBudget(db, limits, 0.4);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("hourly cap");
  });

  it("ignores spending that has fallen out of the window", () => {
    startRentalAt(1, 0.5, 48, 47); // an hour of spend, two days ago
    const daySpend = getSpendSince(db, new Date(Date.now() - 24 * 3_600_000));
    expect(daySpend).toBe(0);
  });
});

describe("the ledger", () => {
  it("records cost when a rental ends", () => {
    startRentalAt(1, 0.6, 2);
    recordRentalEnd(db, 1);
    const row = db.prepare(`SELECT final_cost_dollars FROM vast_rentals WHERE instance_id = 1`).get() as any;
    expect(row.final_cost_dollars).toBeGreaterThan(1.1);
    expect(row.final_cost_dollars).toBeLessThan(1.3);
  });

  it("stops listing a rental as active once ended", () => {
    recordRentalStart(db, { instanceId: 1, purpose: "escalation", dollarsPerHour: 0.3 });
    expect(getActiveRentals(db)).toHaveLength(1);
    recordRentalEnd(db, 1);
    expect(getActiveRentals(db)).toHaveLength(0);
  });

  it("tolerates ending a rental it has never seen", () => {
    expect(() => recordRentalEnd(db, 999)).not.toThrow();
  });
});
