/**
 * Replication onto Vast
 *
 * A child automaton is a Vast instance running the same image with its own
 * genesis prompt, its own wallet, and its own Vast API key.
 *
 * The key is the important part. Children do not inherit the parent's key —
 * they draw one from a pool you provisioned by hand, so a child can only spend
 * against a limit you set on Vast's side, and a lineage cannot quietly consume
 * your balance. The cost is that replication is not autonomous: when the pool
 * runs dry the agent cannot spawn, and only you can refill it. That is the
 * trade you chose, and it is the reason this cannot run away.
 */

import type BetterSqlite3 from "better-sqlite3";
import { createHash } from "crypto";
import { createLogger } from "../observability/logger.js";
import type { VastSettings } from "./config.js";
import { VastClient, type VastOffer } from "./client.js";
import { checkBudget, recordRentalStart } from "./spend.js";

const logger = createLogger("vast-replication");

export interface ReplicationDeps {
  db: BetterSqlite3.Database;
  settings: VastSettings;
  client: VastClient;
}

export interface VastChild {
  instanceId: number;
  name: string;
  genesisPrompt: string;
  keyFingerprint: string;
  createdAt: string;
  status: string;
}

export type SpawnOutcome =
  | { status: "spawned"; child: VastChild; endpointHint: string }
  | { status: "refused"; reason: string };

export function initReplicationTables(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vast_children (
      instance_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      genesis_prompt TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'starting'
    );
    CREATE TABLE IF NOT EXISTS vast_child_keys (
      fingerprint TEXT PRIMARY KEY,
      consumed_at TEXT NOT NULL,
      instance_id INTEGER
    );
  `);
}

/**
 * Identify a key without storing it.
 *
 * The pool lives in the environment; the database only remembers which members
 * have been used. Writing the keys themselves to disk would put a spendable
 * credential in the agent's own state directory, which is the one place it can
 * definitely read.
 */
export function fingerprintKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** First key in the pool that has not been handed to a child yet. */
export function claimUnusedKey(
  db: BetterSqlite3.Database,
  pool: string[],
): { key: string; fingerprint: string } | null {
  for (const key of pool) {
    const fingerprint = fingerprintKey(key);
    const used = db
      .prepare(`SELECT 1 FROM vast_child_keys WHERE fingerprint = ?`)
      .get(fingerprint);
    if (!used) return { key, fingerprint };
  }
  return null;
}

function markKeyConsumed(
  db: BetterSqlite3.Database,
  fingerprint: string,
  instanceId: number,
): void {
  db.prepare(
    `INSERT INTO vast_child_keys (fingerprint, consumed_at, instance_id) VALUES (?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET instance_id = excluded.instance_id`,
  ).run(fingerprint, new Date().toISOString(), instanceId);
}

export function getVastChildren(db: BetterSqlite3.Database): VastChild[] {
  const rows = db
    .prepare(`SELECT * FROM vast_children ORDER BY created_at DESC`)
    .all() as any[];
  return rows.map((r) => ({
    instanceId: r.instance_id,
    name: r.name,
    genesisPrompt: r.genesis_prompt,
    keyFingerprint: r.key_fingerprint,
    createdAt: r.created_at,
    status: r.status,
  }));
}

/** A child runs the same stack, so it wants a modest GPU rather than a big one. */
async function findChildOffer(deps: ReplicationDeps): Promise<VastOffer | null> {
  const offers = await deps.client.searchOffers({
    numGpus: 1,
    minGpuRamMb: 12_000,
    minDiskGb: 40,
    minReliability: deps.settings.escalation.minReliability,
    maxDollarsPerHour: deps.settings.limits.maxDollarsPerHour,
    minInetDownMbps: 100,
    limit: 20,
  });
  return offers[0] ?? null;
}

export async function spawnChildOnVast(
  deps: ReplicationDeps,
  params: { name: string; genesisPrompt: string; creatorAddress?: string },
): Promise<SpawnOutcome> {
  const { settings } = deps;

  if (!settings.childImage) {
    return {
      status: "refused",
      reason:
        "No child image configured. A child runs from a published registry image that Vast " +
        "can pull; set AUTOMATON_VAST_CHILD_IMAGE to one.",
    };
  }

  const claimed = claimUnusedKey(deps.db, settings.childApiKeys);
  if (!claimed) {
    return {
      status: "refused",
      reason:
        settings.childApiKeys.length === 0
          ? "No child API keys are provisioned. Your creator must add keys to " +
            "AUTOMATON_VAST_CHILD_KEYS before you can replicate. You cannot create them yourself."
          : `All ${settings.childApiKeys.length} provisioned child key(s) are already in use. ` +
            "Your creator must add more before you can spawn another child.",
    };
  }

  let offer;
  try {
    offer = await findChildOffer(deps);
  } catch (err: any) {
    // Same distinction as escalation: a broken search is not an empty one.
    const { describeSearchFailure } = await import("./escalation.js");
    return { status: "refused", reason: describeSearchFailure(err) };
  }
  if (!offer) {
    return {
      status: "refused",
      reason:
        `Vast has no machine meeting a child's requirements under ` +
        `$${settings.limits.maxDollarsPerHour}/hr right now. The search worked; nothing matched.`,
    };
  }

  const verdict = checkBudget(deps.db, settings.limits, offer.dphTotal);
  if (!verdict.allowed) {
    return { status: "refused", reason: `Budget refused this rental. ${verdict.reason}` };
  }

  // The child gets its own key and its own genesis prompt. It does not get the
  // parent's key, the parent's wallet, or the parent's child-key pool.
  const env: Record<string, string> = {
    AUTOMATON_LOCAL_MODE: "1",
    AUTOMATON_ROLE: "all",
    AUTOMATON_NAME: params.name,
    AUTOMATON_GENESIS_PROMPT: params.genesisPrompt,
    AUTOMATON_VAST_API_KEY: claimed.key,
  };
  // Deliberately no published ports. The child's Ollama listens on loopback
  // inside its own container and only its own agent talks to it; publishing
  // 11434 would put an unauthenticated inference endpoint on the public
  // internet, for no benefit to anyone but whoever found it.
  if (params.creatorAddress) env.AUTOMATON_CREATOR_ADDRESS = params.creatorAddress;

  if (deps.client.isDryRun) {
    return {
      status: "refused",
      reason:
        `[DRY RUN] Would rent offer ${offer.id} (${offer.gpuName}, $${offer.dphTotal.toFixed(3)}/hr) ` +
        `and start "${params.name}" from ${settings.childImage} with child key ` +
        `${claimed.fingerprint}. Nothing was rented and no key was consumed.`,
    };
  }

  let instanceId: number;
  try {
    instanceId = await deps.client.createInstance({
      offerId: offer.id,
      image: settings.childImage,
      diskGb: 60,
      env,
      label: `automaton-child-${params.name}`,
    });
  } catch (err: any) {
    return { status: "refused", reason: `Vast refused the rental: ${err.message}` };
  }

  const child: VastChild = {
    instanceId,
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    keyFingerprint: claimed.fingerprint,
    createdAt: new Date().toISOString(),
    status: "starting",
  };

  deps.db
    .prepare(
      `INSERT INTO vast_children (instance_id, name, genesis_prompt, key_fingerprint, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      child.instanceId,
      child.name,
      child.genesisPrompt,
      child.keyFingerprint,
      child.createdAt,
      child.status,
    );

  markKeyConsumed(deps.db, claimed.fingerprint, instanceId);
  recordRentalStart(deps.db, {
    instanceId,
    purpose: "child",
    dollarsPerHour: offer.dphTotal,
    label: `child ${params.name}`,
  });

  logger.info(
    `Spawned child "${params.name}" as Vast instance ${instanceId} at $${offer.dphTotal.toFixed(3)}/hr`,
  );

  return {
    status: "spawned",
    child,
    endpointHint:
      `Instance ${instanceId} is starting. It will take several minutes to pull the image ` +
      `and its model before it thinks its first thought.`,
  };
}

/** Destroy a child instance and stop its billing. Its key is not returned to the pool. */
export async function destroyVastChild(
  deps: ReplicationDeps,
  instanceId: number,
): Promise<void> {
  await deps.client.destroyInstance(instanceId);
  deps.db
    .prepare(`UPDATE vast_children SET status = 'destroyed' WHERE instance_id = ?`)
    .run(instanceId);
}
