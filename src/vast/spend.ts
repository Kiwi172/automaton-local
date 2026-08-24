/**
 * Vast Spend Ledger and Caps
 *
 * Records every instance the agent rents and what it is costing, and refuses
 * rentals that would breach the operator's limits.
 *
 * Two things make this necessary rather than nice to have. Vast bills by the
 * hour for as long as an instance exists, so a rental the agent forgets about
 * costs money forever. And local mode deliberately removes the credit-based
 * survival pressure that would otherwise stop a runaway agent — nothing else
 * here says no.
 */

import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import type { VastSpendLimits } from "./config.js";

const logger = createLogger("vast-spend");

export type RentalPurpose = "escalation" | "child";

export interface RentalRecord {
  instanceId: number;
  purpose: RentalPurpose;
  dollarsPerHour: number;
  startedAt: string;
  endedAt: string | null;
  /** Set when the rental ends; until then, cost accrues. */
  finalCostDollars: number | null;
  label: string | null;
}

export function initVastLedger(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vast_rentals (
      instance_id INTEGER PRIMARY KEY,
      purpose TEXT NOT NULL,
      dollars_per_hour REAL NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      final_cost_dollars REAL,
      label TEXT,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vast_rentals_started ON vast_rentals(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vast_rentals_active ON vast_rentals(ended_at);
  `);
}

export function recordRentalStart(
  db: BetterSqlite3.Database,
  rental: { instanceId: number; purpose: RentalPurpose; dollarsPerHour: number; label?: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO vast_rentals
       (instance_id, purpose, dollars_per_hour, started_at, ended_at, final_cost_dollars, label, last_used_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       purpose = excluded.purpose,
       dollars_per_hour = excluded.dollars_per_hour,
       started_at = excluded.started_at,
       ended_at = NULL,
       final_cost_dollars = NULL,
       last_used_at = excluded.last_used_at`,
  ).run(rental.instanceId, rental.purpose, rental.dollarsPerHour, now, rental.label ?? null, now);
}

export function recordRentalEnd(db: BetterSqlite3.Database, instanceId: number): void {
  const row = db
    .prepare(`SELECT dollars_per_hour, started_at FROM vast_rentals WHERE instance_id = ?`)
    .get(instanceId) as { dollars_per_hour: number; started_at: string } | undefined;
  if (!row) return;

  const hours = (Date.now() - new Date(row.started_at).getTime()) / 3_600_000;
  const cost = Math.max(0, hours) * row.dollars_per_hour;
  db.prepare(
    `UPDATE vast_rentals SET ended_at = ?, final_cost_dollars = ? WHERE instance_id = ?`,
  ).run(new Date().toISOString(), cost, instanceId);
  logger.info(`Rental ${instanceId} ended after ${hours.toFixed(2)}h, cost ~$${cost.toFixed(2)}`);
}

/** Mark an instance as used now, so the idle reaper leaves it alone. */
export function touchRental(db: BetterSqlite3.Database, instanceId: number): void {
  db.prepare(`UPDATE vast_rentals SET last_used_at = ? WHERE instance_id = ?`).run(
    new Date().toISOString(),
    instanceId,
  );
}

export function getActiveRentals(db: BetterSqlite3.Database): RentalRecord[] {
  const rows = db
    .prepare(`SELECT * FROM vast_rentals WHERE ended_at IS NULL ORDER BY started_at DESC`)
    .all() as any[];
  return rows.map(toRecord);
}

export function getActiveRentalByPurpose(
  db: BetterSqlite3.Database,
  purpose: RentalPurpose,
): RentalRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM vast_rentals WHERE ended_at IS NULL AND purpose = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(purpose) as any;
  return row ? toRecord(row) : null;
}

export function getLastUsedAt(db: BetterSqlite3.Database, instanceId: number): Date | null {
  const row = db
    .prepare(`SELECT last_used_at FROM vast_rentals WHERE instance_id = ?`)
    .get(instanceId) as { last_used_at: string | null } | undefined;
  return row?.last_used_at ? new Date(row.last_used_at) : null;
}

/**
 * Dollars spent in the window ending now.
 *
 * Counts finished rentals at their final cost and running ones at what they
 * have accrued so far, so a cap cannot be dodged by simply never stopping.
 */
export function getSpendSince(db: BetterSqlite3.Database, since: Date): number {
  const rows = db
    .prepare(
      `SELECT dollars_per_hour, started_at, ended_at, final_cost_dollars
       FROM vast_rentals WHERE ended_at IS NULL OR ended_at >= ?`,
    )
    .all(since.toISOString()) as any[];

  const windowStartMs = since.getTime();
  let total = 0;
  for (const row of rows) {
    const startMs = Math.max(new Date(row.started_at).getTime(), windowStartMs);
    const endMs = row.ended_at ? new Date(row.ended_at).getTime() : Date.now();
    if (endMs <= startMs) continue;
    total += ((endMs - startMs) / 3_600_000) * row.dollars_per_hour;
  }
  return total;
}

export interface BudgetVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Decide whether renting at this hourly rate is permitted right now.
 *
 * Checks the per-instance rate, the concurrency cap, and the rolling hour and
 * day — projecting an hour of the proposed rental into both windows, so a
 * rental that would immediately breach a cap is refused up front rather than
 * discovered halfway through.
 */
export function checkBudget(
  db: BetterSqlite3.Database,
  limits: VastSpendLimits,
  dollarsPerHour: number,
): BudgetVerdict {
  if (dollarsPerHour > limits.maxDollarsPerHour) {
    return {
      allowed: false,
      reason: `$${dollarsPerHour.toFixed(2)}/hr exceeds the per-instance limit of $${limits.maxDollarsPerHour.toFixed(2)}/hr.`,
    };
  }

  const active = getActiveRentals(db);
  if (active.length >= limits.maxConcurrentInstances) {
    return {
      allowed: false,
      reason:
        `${active.length} Vast instance(s) already running, limit is ${limits.maxConcurrentInstances}. ` +
        `Destroy one before renting another.`,
    };
  }

  const hourAgo = new Date(Date.now() - 3_600_000);
  const hourSpend = getSpendSince(db, hourAgo);
  if (hourSpend + dollarsPerHour > limits.maxHourlySpend) {
    return {
      allowed: false,
      reason:
        `Renting at $${dollarsPerHour.toFixed(2)}/hr would put the last hour at ` +
        `$${(hourSpend + dollarsPerHour).toFixed(2)}, over the $${limits.maxHourlySpend.toFixed(2)} hourly cap.`,
    };
  }

  const dayAgo = new Date(Date.now() - 24 * 3_600_000);
  const daySpend = getSpendSince(db, dayAgo);
  if (daySpend + dollarsPerHour > limits.maxDailySpend) {
    return {
      allowed: false,
      reason:
        `Renting at $${dollarsPerHour.toFixed(2)}/hr would put the last 24h at ` +
        `$${(daySpend + dollarsPerHour).toFixed(2)}, over the $${limits.maxDailySpend.toFixed(2)} daily cap.`,
    };
  }

  return { allowed: true, reason: "" };
}

function toRecord(row: any): RentalRecord {
  return {
    instanceId: row.instance_id,
    purpose: row.purpose,
    dollarsPerHour: row.dollars_per_hour,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    finalCostDollars: row.final_cost_dollars,
    label: row.label,
  };
}
