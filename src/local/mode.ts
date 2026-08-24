/**
 * Local Mode
 *
 * Local mode runs the entire automaton on hardware you own: inference through a
 * local OpenAI-compatible server (Ollama by default), tool execution on this
 * machine, and no Conway control plane at all — no API key, no sandbox, no
 * credits, no on-chain registration.
 *
 * Nothing here changes behavior unless local mode is explicitly enabled, either
 * with AUTOMATON_LOCAL_MODE=1 or "localMode": true in automaton.json.
 */

import path from "path";
import type { AutomatonConfig } from "../types.js";

export const DEFAULT_LOCAL_INFERENCE_URL = "http://localhost:11434";
export const DEFAULT_LOCAL_MODEL = "qwen2.5:7b";

/**
 * Balance the local Conway client reports.
 *
 * The survival system derives its tier from a credit balance, and every tier
 * below "normal" sheds capability. Local compute is not metered, so a fixed
 * high balance keeps the agent working instead of having it believe it is
 * starving. Local mode is not free — it costs electricity and your hardware —
 * but nothing in the runtime can meter that, so it is not modelled as credits.
 */
export const LOCAL_CREDITS_CENTS = 1_000_000;

/**
 * Wall-clock budget for one local inference call. Fifteen minutes is generous
 * on purpose: local inference is slow, nothing is being billed for the wait,
 * and a turn that takes ten minutes is still infinitely better than a turn that
 * is killed at two.
 */
export const DEFAULT_LOCAL_INFERENCE_TIMEOUT_MS = 900_000;

export interface LocalModeSettings {
  /** Base URL of the local OpenAI-compatible inference server. */
  inferenceBaseUrl: string;
  /** Model id served by that endpoint, e.g. "qwen2.5:7b". */
  model: string;
  /** Bearer token for the local endpoint. Ollama ignores it; vLLM may not. */
  apiKey: string;
  /** Working directory for exec and relative file paths. */
  workspaceDir: string;
  /** Synthetic credit balance reported to the survival system. */
  creditsCents: number;
  /**
   * How long to wait for one inference call.
   *
   * The shared defaults assume a datacentre GPU: 60s per HTTP request, 120s per
   * agent turn. A 7B model on CPU takes several minutes to ingest an
   * 8,000-token prompt and answer, so with those defaults every single turn
   * times out and the agent never thinks at all. Measured, not guessed.
   */
  inferenceTimeoutMs: number;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Is local mode active? The env var wins over config so a single run can be
 * flipped either way without rewriting automaton.json.
 */
export function isLocalMode(config?: Partial<AutomatonConfig> | null): boolean {
  if (process.env.AUTOMATON_LOCAL_MODE !== undefined) {
    return isTruthy(process.env.AUTOMATON_LOCAL_MODE);
  }
  return config?.localMode === true;
}

/**
 * Resolve the effective local settings. Env vars override config so the Docker
 * stack can point the runtime at its own Ollama service without touching the
 * config file baked into the volume.
 */
export function resolveLocalModeSettings(
  config?: Partial<AutomatonConfig> | null,
): LocalModeSettings {
  const inferenceBaseUrl = (
    process.env.OLLAMA_BASE_URL ||
    config?.ollamaBaseUrl ||
    DEFAULT_LOCAL_INFERENCE_URL
  ).replace(/\/$/, "");

  const model =
    process.env.AUTOMATON_LOCAL_MODEL ||
    config?.inferenceModel ||
    DEFAULT_LOCAL_MODEL;

  const workspaceDir =
    process.env.AUTOMATON_WORKSPACE || process.env.HOME || "/root";

  const creditsEnv = Number(process.env.AUTOMATON_LOCAL_CREDITS_CENTS);
  const creditsCents =
    Number.isFinite(creditsEnv) && creditsEnv >= 0 ? creditsEnv : LOCAL_CREDITS_CENTS;

  const timeoutEnv = Number(process.env.AUTOMATON_LOCAL_INFERENCE_TIMEOUT_MS);
  const inferenceTimeoutMs =
    Number.isFinite(timeoutEnv) && timeoutEnv > 0
      ? timeoutEnv
      : DEFAULT_LOCAL_INFERENCE_TIMEOUT_MS;

  return {
    inferenceBaseUrl,
    model,
    apiKey: process.env.AUTOMATON_LOCAL_API_KEY || "local",
    workspaceDir: path.resolve(workspaceDir),
    creditsCents,
    inferenceTimeoutMs,
  };
}

/**
 * Hostname of the local inference endpoint, for the HTTP client's plaintext
 * allowlist. Returns null for an unparseable or already-HTTPS URL — those need
 * no exemption.
 */
export function localInferenceHttpHost(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol.toLowerCase() !== "http:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}
