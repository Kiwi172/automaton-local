/**
 * Asking a Brighter Model
 *
 * The local model is small. When it meets something beyond it, this rents a GPU
 * on Vast, serves a larger model there with vLLM, asks the question, and destroys
 * the instance once it has been idle for a while.
 *
 * The shape of the cost is worth understanding before using it. Renting is
 * quick; becoming useful is not — the instance has to pull tens of gigabytes of
 * weights before it answers, which typically takes five to fifteen minutes and
 * is billed. One question therefore costs about the same as ten, so escalation
 * is worth it for a genuinely hard problem and wasteful for a passing thought.
 * The idle timeout exists so a burst of questions shares one rental.
 */

import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import { VLLM_PORT, type VastSettings } from "./config.js";
import { VastClient, type VastOffer } from "./client.js";
import {
  checkBudget,
  getActiveRentalByPurpose,
  getLastUsedAt,
  getActiveRentals,
  recordRentalEnd,
  recordRentalStart,
  touchRental,
} from "./spend.js";

const logger = createLogger("vast-escalation");

const READY_POLL_INTERVAL_MS = 15_000;
const QUERY_TIMEOUT_MS = 180_000;

export interface EscalationDeps {
  db: BetterSqlite3.Database;
  settings: VastSettings;
  client: VastClient;
}

export type EscalationOutcome =
  | { status: "answered"; answer: string; model: string; instanceId: number }
  | { status: "refused"; reason: string };

/**
 * Refuse plaintext unless the operator opted in.
 *
 * The endpoint is a raw IP on the public internet. Everything sent to it — the
 * question, and whatever context the agent includes — crosses unencrypted.
 */
function plaintextVerdict(settings: VastSettings): string | null {
  if (settings.allowPlaintext) return null;
  return (
    "Escalation is configured but plaintext HTTP to rented instances is not allowed. " +
    "Traffic to a Vast box crosses the public internet unencrypted, including your " +
    "prompt and context. Set AUTOMATON_VAST_ALLOW_PLAINTEXT=1 to accept that, or put " +
    "a TLS proxy in front of the instance."
  );
}

/** Pick the cheapest offer that can actually serve the model. */
export async function findEscalationOffer(
  deps: EscalationDeps,
): Promise<VastOffer | null> {
  const { escalation, limits } = deps.settings;
  const offers = await deps.client.searchOffers({
    gpuNames: escalation.gpuNames,
    numGpus: escalation.numGpus,
    minGpuRamMb: escalation.minGpuRamMb,
    minDiskGb: escalation.diskGb,
    minReliability: escalation.minReliability,
    maxDollarsPerHour: limits.maxDollarsPerHour,
    // Weights are a large download and it is billed while it happens, so a slow
    // link is a direct cost, not just an annoyance.
    minInetDownMbps: 200,
    limit: 20,
  });
  return offers[0] ?? null;
}

/**
 * Rent an instance and wait until vLLM answers, or give up.
 *
 * On any failure after the rental exists, the instance is destroyed before
 * returning. A half-started instance that nobody tracks is the expensive
 * failure mode.
 */
async function rentAndWait(
  deps: EscalationDeps,
  offer: VastOffer,
): Promise<{ instanceId: number; endpoint: string }> {
  const { escalation } = deps.settings;

  const env: Record<string, string> = { [`-p ${VLLM_PORT}:${VLLM_PORT}`]: "1" };
  if (escalation.huggingFaceToken) env.HF_TOKEN = escalation.huggingFaceToken;

  const instanceId = await deps.client.createInstance({
    offerId: offer.id,
    image: escalation.image,
    diskGb: escalation.diskGb,
    env,
    args: [
      "--model",
      escalation.model,
      "--host",
      "0.0.0.0",
      "--port",
      String(VLLM_PORT),
    ],
    label: "automaton-escalation",
  });

  if (instanceId < 0) {
    // Dry run: nothing was rented, so there is nothing to wait for.
    throw new Error("dry-run: no instance created");
  }

  recordRentalStart(deps.db, {
    instanceId,
    purpose: "escalation",
    dollarsPerHour: offer.dphTotal,
    label: `${escalation.model} on ${offer.gpuName}`,
  });

  try {
    const endpoint = await waitForReady(deps, instanceId);
    return { instanceId, endpoint };
  } catch (err) {
    logger.warn(`Escalation instance ${instanceId} never became ready; destroying it`);
    await deps.client.destroyInstance(instanceId).catch(() => {});
    recordRentalEnd(deps.db, instanceId);
    throw err;
  }
}

async function waitForReady(deps: EscalationDeps, instanceId: number): Promise<string> {
  const deadline = Date.now() + deps.settings.escalation.readyTimeoutMs;
  let endpoint: string | null = null;

  while (Date.now() < deadline) {
    const instance = await deps.client.getInstance(instanceId).catch(() => null);
    if (instance) {
      if (instance.actualStatus === "exited" || instance.actualStatus === "offline") {
        throw new Error(`Instance ${instanceId} died during startup (${instance.actualStatus})`);
      }
      endpoint = endpoint ?? VastClient.endpointFor(instance, VLLM_PORT);
    }

    if (endpoint) {
      // The port is mapped; now wait for vLLM to finish loading weights.
      const ready = await fetch(`${endpoint}/v1/models`, {
        signal: AbortSignal.timeout(10_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ready) {
        logger.info(`Escalation endpoint ready at ${endpoint}`);
        return endpoint;
      }
    }

    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Instance ${instanceId} did not serve ${deps.settings.escalation.model} within ` +
      `${Math.round(deps.settings.escalation.readyTimeoutMs / 60_000)} minutes`,
  );
}

/** Reuse a live escalation instance if one is already serving. */
async function findLiveEndpoint(deps: EscalationDeps): Promise<{ instanceId: number; endpoint: string } | null> {
  const existing = getActiveRentalByPurpose(deps.db, "escalation");
  if (!existing) return null;

  const instance = await deps.client.getInstance(existing.instanceId).catch(() => null);
  if (!instance || instance.actualStatus !== "running") return null;

  const endpoint = VastClient.endpointFor(instance, VLLM_PORT);
  if (!endpoint) return null;

  const ready = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.ok)
    .catch(() => false);
  return ready ? { instanceId: existing.instanceId, endpoint } : null;
}

/**
 * Ask the bigger model a question.
 *
 * Every refusal path returns a sentence rather than throwing, because the
 * caller is a language model deciding what to do next and a budget refusal is
 * information, not an error.
 */
export async function askBigModel(
  deps: EscalationDeps,
  params: { question: string; context?: string },
): Promise<EscalationOutcome> {
  const plaintext = plaintextVerdict(deps.settings);
  if (plaintext) return { status: "refused", reason: plaintext };

  let target = await findLiveEndpoint(deps);

  if (!target) {
    const offer = await findEscalationOffer(deps).catch((err) => {
      logger.warn(`Offer search failed: ${err.message}`);
      return null;
    });
    if (!offer) {
      return {
        status: "refused",
        reason:
          `No Vast offer matched: ${deps.settings.escalation.gpuNames.join("/")} with ` +
          `${deps.settings.escalation.minGpuRamMb}MB VRAM under ` +
          `$${deps.settings.limits.maxDollarsPerHour}/hr. Raise the limit or widen the GPU list.`,
      };
    }

    const verdict = checkBudget(deps.db, deps.settings.limits, offer.dphTotal);
    if (!verdict.allowed) {
      return { status: "refused", reason: `Budget refused this rental. ${verdict.reason}` };
    }

    if (deps.client.isDryRun) {
      return {
        status: "refused",
        reason:
          `[DRY RUN] Would rent offer ${offer.id} (${offer.gpuName}, ` +
          `$${offer.dphTotal.toFixed(3)}/hr) to serve ${deps.settings.escalation.model}. ` +
          `Nothing was rented and no money was spent.`,
      };
    }

    logger.info(
      `Escalating: renting ${offer.gpuName} at $${offer.dphTotal.toFixed(3)}/hr for ${deps.settings.escalation.model}`,
    );
    try {
      target = await rentAndWait(deps, offer);
    } catch (err: any) {
      return { status: "refused", reason: `Could not bring up the bigger model: ${err.message}` };
    }
  }

  try {
    const answer = await query(target.endpoint, deps.settings.escalation.model, params);
    touchRental(deps.db, target.instanceId);
    return {
      status: "answered",
      answer,
      model: deps.settings.escalation.model,
      instanceId: target.instanceId,
    };
  } catch (err: any) {
    return { status: "refused", reason: `The bigger model failed to answer: ${err.message}` };
  }
}

async function query(
  endpoint: string,
  model: string,
  params: { question: string; context?: string },
): Promise<string> {
  const messages = [
    {
      role: "system",
      content:
        "You are advising a smaller autonomous agent that has hit the limit of its own " +
        "reasoning. Answer its question directly and concretely. Give it something it can " +
        "act on in a single step, not a plan for a plan.",
    },
    {
      role: "user",
      content: params.context
        ? `Context:\n${params.context}\n\nQuestion:\n${params.question}`
        : params.question,
    },
  ];

  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: 2048, stream: false }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("no completion returned");
  return content;
}

/**
 * Destroy instances that have gone idle.
 *
 * Runs from the heartbeat so it keeps working while the agent sleeps — which is
 * exactly when a forgotten rental would otherwise keep billing.
 */
export async function reapIdleInstances(deps: EscalationDeps): Promise<number> {
  const active = getActiveRentals(deps.db);
  let reaped = 0;

  for (const rental of active) {
    // Children are meant to outlive the turn that created them.
    if (rental.purpose !== "escalation") continue;

    const lastUsed = getLastUsedAt(deps.db, rental.instanceId);
    const referenceMs = (lastUsed ?? new Date(rental.startedAt)).getTime();
    const idleMs = Date.now() - referenceMs;
    if (idleMs < deps.settings.escalation.idleTimeoutMs) continue;

    logger.info(
      `Reaping idle escalation instance ${rental.instanceId} after ${Math.round(idleMs / 60_000)} min`,
    );
    try {
      await deps.client.destroyInstance(rental.instanceId);
      recordRentalEnd(deps.db, rental.instanceId);
      reaped++;
    } catch (err: any) {
      logger.warn(`Failed to reap instance ${rental.instanceId}: ${err.message}`);
    }
  }

  return reaped;
}
