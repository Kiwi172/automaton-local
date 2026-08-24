/**
 * Vast.ai Configuration
 *
 * Off unless an API key is set. Every limit here is enforced in code rather
 * than asked for in the prompt, for the same reason the donation limits are:
 * renting GPUs spends real money, and a small model's judgement is not what
 * should stand between your balance and a runaway loop.
 */

import type { AutomatonConfig } from "../types.js";

/**
 * Default escalation model.
 *
 * A 4-bit 32B fits on a single 24GB card, which is the cheapest tier that is
 * meaningfully brighter than a local 7B. A 72B would be better still but needs
 * two cards or an 80GB one, roughly quadrupling the hourly cost.
 */
export const DEFAULT_BIG_MODEL = "Qwen/Qwen2.5-32B-Instruct-AWQ";
export const DEFAULT_VLLM_IMAGE = "vllm/vllm-openai:latest";
/** Container port vLLM's OpenAI-compatible server listens on. */
export const VLLM_PORT = 8000;

export interface VastSpendLimits {
  /** Most any single instance may cost per hour. */
  maxDollarsPerHour: number;
  /** Most all Vast activity may cost in a rolling hour. */
  maxHourlySpend: number;
  /** Most all Vast activity may cost in a rolling 24h. */
  maxDailySpend: number;
  /** Instances that may run at once, across escalation and children. */
  maxConcurrentInstances: number;
}

export interface VastEscalationSettings {
  /** Hugging Face model id served by vLLM. */
  model: string;
  image: string;
  gpuNames: string[];
  numGpus: number;
  minGpuRamMb: number;
  diskGb: number;
  minReliability: number;
  /** Destroy the instance after this long without a query. */
  idleTimeoutMs: number;
  /** Give up if the server is not answering by then. Weights take a while. */
  readyTimeoutMs: number;
  /** Token for gated Hugging Face repos, passed to the instance. */
  huggingFaceToken?: string;
}

export interface VastSettings {
  apiKey: string;
  dryRun: boolean;
  limits: VastSpendLimits;
  escalation: VastEscalationSettings;
  /**
   * Operator-provisioned API keys, one consumed per child.
   *
   * Children get their own key rather than the parent's, so a child cannot
   * spend the parent's balance and each has its own limit set on Vast's side.
   * The consequence is that replication is not autonomous: when the pool is
   * empty the agent cannot spawn, and only you can refill it.
   */
  childApiKeys: string[];
  /** Registry image a child automaton runs. No default — it must be published somewhere Vast can pull. */
  childImage?: string;
  /**
   * Allow plaintext HTTP to rented instances.
   *
   * Traffic to a Vast box crosses the public internet. Without a TLS proxy in
   * front, everything the agent sends the big model — its prompt, its context,
   * whatever it is working on — travels unencrypted. Off by default.
   */
  allowPlaintext: boolean;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(name: string): boolean {
  const raw = (process.env[name] || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Resolve Vast settings, or null when no API key is configured. */
export function resolveVastSettings(
  config?: Partial<AutomatonConfig> | null,
): VastSettings | null {
  const apiKey = (
    process.env.AUTOMATON_VAST_API_KEY ||
    config?.vastApiKey ||
    ""
  ).trim();
  if (!apiKey) return null;

  return {
    apiKey,
    dryRun: envFlag("AUTOMATON_VAST_DRY_RUN"),
    limits: {
      maxDollarsPerHour: envNumber("AUTOMATON_VAST_MAX_DPH", 0.6),
      maxHourlySpend: envNumber("AUTOMATON_VAST_MAX_HOURLY_SPEND", 2),
      maxDailySpend: envNumber("AUTOMATON_VAST_MAX_DAILY_SPEND", 10),
      maxConcurrentInstances: envNumber("AUTOMATON_VAST_MAX_CONCURRENT_INSTANCES", 1),
    },
    escalation: {
      model: process.env.AUTOMATON_VAST_BIG_MODEL || DEFAULT_BIG_MODEL,
      image: process.env.AUTOMATON_VAST_IMAGE || DEFAULT_VLLM_IMAGE,
      gpuNames: envList("AUTOMATON_VAST_GPU_NAMES", [
        "RTX_4090",
        "RTX_A6000",
        "A100_PCIE",
        "A100_SXM4",
      ]),
      numGpus: envNumber("AUTOMATON_VAST_NUM_GPUS", 1),
      minGpuRamMb: envNumber("AUTOMATON_VAST_MIN_GPU_RAM_MB", 24_000),
      diskGb: envNumber("AUTOMATON_VAST_DISK_GB", 80),
      minReliability: envNumber("AUTOMATON_VAST_MIN_RELIABILITY", 0.98),
      idleTimeoutMs: envNumber("AUTOMATON_VAST_IDLE_TIMEOUT_MINUTES", 15) * 60_000,
      readyTimeoutMs: envNumber("AUTOMATON_VAST_READY_TIMEOUT_MINUTES", 25) * 60_000,
      huggingFaceToken: process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || undefined,
    },
    childApiKeys: envList("AUTOMATON_VAST_CHILD_KEYS", []),
    childImage: process.env.AUTOMATON_VAST_CHILD_IMAGE || config?.vastChildImage || undefined,
    allowPlaintext: envFlag("AUTOMATON_VAST_ALLOW_PLAINTEXT"),
  };
}
