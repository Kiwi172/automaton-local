/**
 * Asking a bigger model: refusal paths and the idle reaper.
 *
 * Most of the value here is in what it declines to do. Renting is the only
 * action in this codebase that spends money continuously rather than once, so
 * the paths that stop before renting matter more than the one that succeeds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { askBigModel, reapIdleInstances } from "../../vast/escalation.js";
import {
  getActiveRentals,
  initVastLedger,
  recordRentalStart,
  touchRental,
} from "../../vast/spend.js";
import { VastClient } from "../../vast/client.js";
import type { VastSettings } from "../../vast/config.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

let db: BetterSqlite3.Database;
beforeEach(() => {
  db = new Database(":memory:");
  initVastLedger(db);
});

function settings(overrides: Partial<VastSettings> = {}): VastSettings {
  return {
    apiKey: "k",
    dryRun: false,
    limits: {
      maxDollarsPerHour: 0.6,
      maxHourlySpend: 5,
      maxDailySpend: 20,
      maxConcurrentInstances: 1,
    },
    escalation: {
      model: "Qwen/Qwen2.5-32B-Instruct-AWQ",
      image: "vllm/vllm-openai:latest",
      gpuNames: ["RTX_4090"],
      numGpus: 1,
      minGpuRamMb: 24_000,
      diskGb: 80,
      minReliability: 0.98,
      idleTimeoutMs: 900_000,
      readyTimeoutMs: 60_000,
    },
    childApiKeys: [],
    allowPlaintext: true,
    ...overrides,
  };
}

function mockApi(handlers: { offers?: any[]; onDestroy?: () => void } = {}) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (url: any, options: any) => {
    const u = String(url);
    calls.push(`${options?.method ?? "GET"} ${u}`);
    if (u.includes("/bundles/")) {
      return new Response(JSON.stringify({ offers: handlers.offers ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (options?.method === "DELETE") {
      handlers.onDestroy?.();
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
  return calls;
}

const CHEAP_OFFER = {
  id: 7,
  gpu_name: "RTX_4090",
  num_gpus: 1,
  gpu_ram: 24576,
  dph_total: 0.25,
  disk_space: 100,
  reliability: 0.99,
};

describe("plaintext", () => {
  it("refuses by default, because the prompt would cross the internet in the clear", async () => {
    const calls = mockApi({ offers: [CHEAP_OFFER] });
    const s = settings({ allowPlaintext: false });
    const outcome = await askBigModel(
      { db, settings: s, client: new VastClient({ apiKey: "k" }) },
      { question: "why" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/unencrypted/i);
    // Nothing was even searched for, let alone rented.
    expect(calls).toHaveLength(0);
  });
});

describe("refusing before spending", () => {
  it("refuses when no offer matches", async () => {
    mockApi({ offers: [] });
    const outcome = await askBigModel(
      { db, settings: settings(), client: new VastClient({ apiKey: "k" }) },
      { question: "why" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/No Vast offer matched/i);
  });

  it("refuses when the budget cap is already used up, without renting", async () => {
    const calls = mockApi({ offers: [CHEAP_OFFER] });
    recordRentalStart(db, { instanceId: 1, purpose: "child", dollarsPerHour: 0.3 });
    const outcome = await askBigModel(
      { db, settings: settings(), client: new VastClient({ apiKey: "k" }) },
      { question: "why" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/budget/i);
    expect(calls.some((c) => c.includes("PUT"))).toBe(false);
  });

  it("reports what it would rent in dry run, and rents nothing", async () => {
    const calls = mockApi({ offers: [CHEAP_OFFER] });
    const outcome = await askBigModel(
      { db, settings: settings({ dryRun: true }), client: new VastClient({ apiKey: "k", dryRun: true }) },
      { question: "why" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toContain("DRY RUN");
    expect(outcome.status === "refused" && outcome.reason).toContain("0.250");
    expect(calls.some((c) => c.includes("PUT"))).toBe(false);
    expect(getActiveRentals(db)).toHaveLength(0);
  });
});

describe("the idle reaper", () => {
  it("destroys an escalation instance that has gone quiet", async () => {
    let destroyed = false;
    mockApi({ onDestroy: () => { destroyed = true; } });

    recordRentalStart(db, { instanceId: 42, purpose: "escalation", dollarsPerHour: 0.3 });
    // Backdate its last use past the idle timeout.
    db.prepare(`UPDATE vast_rentals SET last_used_at = ? WHERE instance_id = 42`).run(
      new Date(Date.now() - 3_600_000).toISOString(),
    );

    const reaped = await reapIdleInstances({
      db,
      settings: settings(),
      client: new VastClient({ apiKey: "k" }),
    });

    expect(reaped).toBe(1);
    expect(destroyed).toBe(true);
    expect(getActiveRentals(db)).toHaveLength(0);
  });

  it("leaves a recently used instance alone", async () => {
    mockApi();
    recordRentalStart(db, { instanceId: 42, purpose: "escalation", dollarsPerHour: 0.3 });
    touchRental(db, 42);
    const reaped = await reapIdleInstances({
      db,
      settings: settings(),
      client: new VastClient({ apiKey: "k" }),
    });
    expect(reaped).toBe(0);
    expect(getActiveRentals(db)).toHaveLength(1);
  });

  it("never reaps a child, which is meant to outlive the turn that made it", async () => {
    mockApi();
    recordRentalStart(db, { instanceId: 99, purpose: "child", dollarsPerHour: 0.2 });
    db.prepare(`UPDATE vast_rentals SET last_used_at = ? WHERE instance_id = 99`).run(
      new Date(Date.now() - 86_400_000).toISOString(),
    );
    const reaped = await reapIdleInstances({
      db,
      settings: settings(),
      client: new VastClient({ apiKey: "k" }),
    });
    expect(reaped).toBe(0);
    expect(getActiveRentals(db)).toHaveLength(1);
  });

  it("keeps going when one instance cannot be destroyed", async () => {
    globalThis.fetch = vi.fn(async (url: any, options: any) => {
      if (options?.method === "DELETE" && String(url).includes("/1/")) {
        return new Response("nope", { status: 500 });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    for (const id of [1, 2]) {
      recordRentalStart(db, { instanceId: id, purpose: "escalation", dollarsPerHour: 0.3 });
      db.prepare(`UPDATE vast_rentals SET last_used_at = ? WHERE instance_id = ?`).run(
        new Date(Date.now() - 3_600_000).toISOString(),
        id,
      );
    }

    const reaped = await reapIdleInstances({
      db,
      settings: settings(),
      client: new VastClient({ apiKey: "k" }),
    });
    // One failed, but the other was still cleaned up rather than the whole
    // sweep aborting on the first error.
    expect(reaped).toBe(1);
  });
});
