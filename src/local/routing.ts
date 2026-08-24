/**
 * Local Inference Routing
 *
 * The default routing matrix names Conway and OpenAI models per survival tier.
 * Those are seeded into the model registry at startup, so without an override
 * the router would pick "gpt-5.2" and try to reach a control plane that local
 * mode does not have.
 *
 * Local mode replaces the matrix with one that points every tier and task at
 * the model the local endpoint actually serves. Cost ceilings are lifted
 * because local inference is not metered — the real limits are wall-clock time
 * and the size of your machine.
 */

import type { InferenceTaskType, RoutingMatrix, SurvivalTier } from "../types.js";

const TIERS: SurvivalTier[] = ["high", "normal", "low_compute", "critical", "dead"];
const TASKS: InferenceTaskType[] = [
  "agent_turn",
  "heartbeat_triage",
  "safety_check",
  "summarization",
  "planning",
];

/**
 * Per-task token budgets. Small local models degrade badly on long outputs and
 * every token is wall-clock time on your own hardware, so these are tighter
 * than the cloud defaults.
 */
const MAX_TOKENS: Record<InferenceTaskType, number> = {
  agent_turn: 4096,
  heartbeat_triage: 1024,
  safety_check: 2048,
  summarization: 2048,
  planning: 4096,
};

/**
 * Build a routing matrix that sends everything to the local model.
 *
 * @param model      Model id served by the local endpoint.
 * @param fallbacks  Optional further local models, tried in order if the first
 *                   is not registered.
 */
export function buildLocalRoutingMatrix(
  model: string,
  fallbacks: string[] = [],
): RoutingMatrix {
  const candidates = [model, ...fallbacks].filter(
    (id, index, all) => !!id && all.indexOf(id) === index,
  );

  const matrix = {} as RoutingMatrix;
  for (const tier of TIERS) {
    const perTask = {} as Record<InferenceTaskType, { candidates: string[]; maxTokens: number; ceilingCents: number }>;
    for (const task of TASKS) {
      perTask[task] = {
        candidates,
        maxTokens: MAX_TOKENS[task],
        // -1 = no cost ceiling. Local inference costs no credits.
        ceilingCents: -1,
      };
    }
    matrix[tier] = perTask;
  }
  return matrix;
}

/**
 * Per-task wall-clock budgets for local inference.
 *
 * The shared TASK_TIMEOUTS allow 120s for an agent turn. On a 16-core CPU with
 * no GPU, a 7B model needs several minutes just to ingest this agent's
 * ~8,000-token prompt, so every turn is aborted before it produces anything.
 * These scale off a single configured budget instead.
 */
export function buildLocalTaskTimeouts(inferenceTimeoutMs: number): Record<string, number> {
  return {
    agent_turn: inferenceTimeoutMs,
    planning: inferenceTimeoutMs,
    summarization: Math.round(inferenceTimeoutMs / 2),
    safety_check: Math.round(inferenceTimeoutMs / 2),
    // Triage is meant to be cheap; if it is slow, something is wrong anyway.
    heartbeat_triage: Math.round(inferenceTimeoutMs / 4),
  };
}
