/**
 * Replication with operator-provisioned keys.
 *
 * The design decision under test: a child gets its own Vast key drawn from a
 * pool the operator fills by hand, never the parent's. That bounds what a
 * lineage can spend, at the cost of replication not being autonomous — when the
 * pool is empty the agent simply cannot spawn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  claimUnusedKey,
  fingerprintKey,
  getVastChildren,
  initReplicationTables,
  spawnChildOnVast,
} from "../../vast/replication.js";
import { initVastLedger, getActiveRentals } from "../../vast/spend.js";
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
  initReplicationTables(db);
});

function settings(overrides: Partial<VastSettings> = {}): VastSettings {
  return {
    apiKey: "parent-key",
    dryRun: false,
    limits: {
      maxDollarsPerHour: 0.6,
      maxHourlySpend: 5,
      maxDailySpend: 20,
      maxConcurrentInstances: 5,
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
      readyTimeoutMs: 1_500_000,
    },
    childApiKeys: ["child-key-one", "child-key-two"],
    childImage: "registry.example/automaton:latest",
    allowPlaintext: true,
    ...overrides,
  };
}

function mockVastApi(created = 555) {
  const calls: { url: string; options: any }[] = [];
  globalThis.fetch = vi.fn(async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    const u = String(url);
    if (u.includes("/bundles/")) {
      return new Response(
        JSON.stringify({
          offers: [{ id: 7, gpu_name: "RTX_4090", num_gpus: 1, gpu_ram: 24576, dph_total: 0.25, disk_space: 100, reliability: 0.99 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ success: true, new_contract: created }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
  return calls;
}

describe("the key pool", () => {
  it("hands out each key once", () => {
    const pool = ["a", "b"];
    const first = claimUnusedKey(db, pool);
    expect(first?.key).toBe("a");

    db.prepare(`INSERT INTO vast_child_keys (fingerprint, consumed_at) VALUES (?, ?)`).run(
      fingerprintKey("a"),
      new Date().toISOString(),
    );

    expect(claimUnusedKey(db, pool)?.key).toBe("b");
  });

  it("returns null when every key is spent", () => {
    for (const key of ["a", "b"]) {
      db.prepare(`INSERT INTO vast_child_keys (fingerprint, consumed_at) VALUES (?, ?)`).run(
        fingerprintKey(key),
        new Date().toISOString(),
      );
    }
    expect(claimUnusedKey(db, ["a", "b"])).toBeNull();
  });

  it("stores a fingerprint, never the key itself", () => {
    mockVastApi();
    const fingerprint = fingerprintKey("child-key-one");
    expect(fingerprint).not.toContain("child-key-one");
    expect(fingerprint).toHaveLength(16);
  });
});

describe("spawning", () => {
  it("rents an instance and passes the child its own key", async () => {
    const calls = mockVastApi();
    const s = settings();
    const outcome = await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "Watch the feeds and summarise." },
    );

    expect(outcome.status).toBe("spawned");
    const create = calls.find((c) => c.url.includes("/asks/"));
    const body = JSON.parse(create!.options.body);
    expect(body.env.AUTOMATON_VAST_API_KEY).toBe("child-key-one");
    expect(body.env.AUTOMATON_VAST_API_KEY).not.toBe(s.apiKey);
    expect(body.env.AUTOMATON_GENESIS_PROMPT).toBe("Watch the feeds and summarise.");
    expect(body.image).toBe("registry.example/automaton:latest");
  });

  it("publishes no ports, so the child's Ollama stays off the public internet", async () => {
    const calls = mockVastApi();
    const s = settings();
    await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "x" },
    );
    const body = JSON.parse(calls.find((c) => c.url.includes("/asks/"))!.options.body);
    const portKeys = Object.keys(body.env).filter((k) => k.startsWith("-p "));
    expect(portKeys).toEqual([]);
  });

  it("does not give the child the parent's child-key pool", async () => {
    const calls = mockVastApi();
    const s = settings();
    await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "x" },
    );
    const body = JSON.parse(calls.find((c) => c.url.includes("/asks/"))!.options.body);
    // A child that could spawn grandchildren on the same pool would defeat the
    // point of provisioning keys by hand.
    expect(body.env.AUTOMATON_VAST_CHILD_KEYS).toBeUndefined();
  });

  it("records the child and the rental", async () => {
    mockVastApi(777);
    const s = settings();
    await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "x" },
    );

    const children = getVastChildren(db);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ instanceId: 777, name: "scout" });
    expect(getActiveRentals(db).some((r) => r.purpose === "child")).toBe(true);
  });

  it("consumes a key so the next spawn uses the next one", async () => {
    mockVastApi();
    const s = settings();
    const deps = { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) };
    await spawnChildOnVast(deps, { name: "one", genesisPrompt: "x" });
    expect(claimUnusedKey(db, s.childApiKeys)?.key).toBe("child-key-two");
  });
});

describe("refusals", () => {
  it("refuses when no child keys are provisioned, and says who can fix it", async () => {
    const s = settings({ childApiKeys: [] });
    const outcome = await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "x" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/creator must add keys/i);
  });

  it("refuses when the pool is exhausted rather than reusing a key", async () => {
    const s = settings({ childApiKeys: ["only-one"] });
    db.prepare(`INSERT INTO vast_child_keys (fingerprint, consumed_at) VALUES (?, ?)`).run(
      fingerprintKey("only-one"),
      new Date().toISOString(),
    );
    const outcome = await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "x" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/already in use/i);
  });

  it("refuses without a child image, since Vast must pull one", async () => {
    const s = settings({ childImage: undefined });
    const outcome = await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "x" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toMatch(/child image/i);
  });

  it("refuses when the budget says no, before renting anything", async () => {
    const calls = mockVastApi();
    const s = settings({
      limits: { maxDollarsPerHour: 0.6, maxHourlySpend: 5, maxDailySpend: 20, maxConcurrentInstances: 0 },
    });
    const outcome = await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey }) },
      { name: "scout", genesisPrompt: "x" },
    );
    expect(outcome.status).toBe("refused");
    expect(calls.some((c) => c.url.includes("/asks/"))).toBe(false);
  });

  it("spends nothing and consumes no key in dry run", async () => {
    const calls = mockVastApi();
    const s = settings({ dryRun: true });
    const outcome = await spawnChildOnVast(
      { db, settings: s, client: new VastClient({ apiKey: s.apiKey, dryRun: true }) },
      { name: "scout", genesisPrompt: "x" },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toContain("DRY RUN");
    expect(calls.some((c) => c.url.includes("/asks/"))).toBe(false);
    expect(claimUnusedKey(db, s.childApiKeys)?.key).toBe("child-key-one");
    expect(getVastChildren(db)).toHaveLength(0);
  });
});
