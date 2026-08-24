/**
 * Local mode detection, settings resolution, routing and tool filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_LOCAL_INFERENCE_URL,
  DEFAULT_LOCAL_MODEL,
  isLocalMode,
  localInferenceHttpHost,
  resolveLocalModeSettings,
} from "../../local/mode.js";
import { buildLocalRoutingMatrix } from "../../local/routing.js";
import { CLOUD_ONLY_TOOLS, filterToolsForLocalMode } from "../../local/tools.js";
import type { AutomatonTool } from "../../types.js";

const LOCAL_ENV_KEYS = [
  "AUTOMATON_LOCAL_MODE",
  "AUTOMATON_LOCAL_MODEL",
  "AUTOMATON_LOCAL_API_KEY",
  "AUTOMATON_LOCAL_CREDITS_CENTS",
  "AUTOMATON_LOCAL_ALLOW_CLOUD_TOOLS",
  "AUTOMATON_WORKSPACE",
  "OLLAMA_BASE_URL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of LOCAL_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isLocalMode", () => {
  it("is off by default, so a cloud automaton is unaffected", () => {
    expect(isLocalMode()).toBe(false);
    expect(isLocalMode({ name: "x" } as any)).toBe(false);
  });

  it("reads the config flag", () => {
    expect(isLocalMode({ localMode: true } as any)).toBe(true);
  });

  it("accepts the usual truthy spellings from env", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.AUTOMATON_LOCAL_MODE = value;
      expect(isLocalMode()).toBe(true);
    }
  });

  it("lets env override config in both directions", () => {
    process.env.AUTOMATON_LOCAL_MODE = "0";
    expect(isLocalMode({ localMode: true } as any)).toBe(false);

    process.env.AUTOMATON_LOCAL_MODE = "1";
    expect(isLocalMode({ localMode: false } as any)).toBe(true);
  });
});

describe("resolveLocalModeSettings", () => {
  it("falls back to documented defaults", () => {
    const settings = resolveLocalModeSettings(null);
    expect(settings.inferenceBaseUrl).toBe(DEFAULT_LOCAL_INFERENCE_URL);
    expect(settings.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(settings.creditsCents).toBeGreaterThan(0);
  });

  it("prefers env over config", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    process.env.AUTOMATON_LOCAL_MODEL = "llama3.1:8b";
    const settings = resolveLocalModeSettings({
      ollamaBaseUrl: "http://localhost:11434",
      inferenceModel: "qwen2.5:7b",
    } as any);
    expect(settings.inferenceBaseUrl).toBe("http://ollama:11434");
    expect(settings.model).toBe("llama3.1:8b");
  });

  it("strips a trailing slash so URL joining cannot double up", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434/";
    expect(resolveLocalModeSettings(null).inferenceBaseUrl).toBe("http://ollama:11434");
  });

  it("ignores a non-numeric credit override rather than reporting NaN", () => {
    process.env.AUTOMATON_LOCAL_CREDITS_CENTS = "not-a-number";
    expect(resolveLocalModeSettings(null).creditsCents).toBeGreaterThan(0);
  });
});

describe("localInferenceHttpHost", () => {
  it("extracts the host of a plaintext endpoint", () => {
    expect(localInferenceHttpHost("http://ollama:11434")).toBe("ollama");
    expect(localInferenceHttpHost("http://192.168.1.40:11434")).toBe("192.168.1.40");
  });

  it("returns null for https and for junk, since neither needs an exemption", () => {
    expect(localInferenceHttpHost("https://ollama:11434")).toBeNull();
    expect(localInferenceHttpHost("not a url")).toBeNull();
  });
});

describe("buildLocalRoutingMatrix", () => {
  it("routes every tier and task at the local model", () => {
    const matrix = buildLocalRoutingMatrix("qwen2.5:7b");
    for (const tier of ["high", "normal", "low_compute", "critical", "dead"] as const) {
      for (const task of [
        "agent_turn",
        "heartbeat_triage",
        "safety_check",
        "summarization",
        "planning",
      ] as const) {
        expect(matrix[tier][task].candidates).toContain("qwen2.5:7b");
        expect(matrix[tier][task].maxTokens).toBeGreaterThan(0);
      }
    }
  });

  it("never leaves a tier with no candidate, which would stall the router", () => {
    const matrix = buildLocalRoutingMatrix("qwen2.5:7b");
    // The default matrix empties candidates at critical/dead. Locally there is
    // no credit balance to run out of, so thinking must not stop.
    expect(matrix.critical.agent_turn.candidates.length).toBeGreaterThan(0);
    expect(matrix.dead.agent_turn.candidates.length).toBeGreaterThan(0);
  });

  it("keeps fallbacks in order and drops duplicates", () => {
    const matrix = buildLocalRoutingMatrix("a", ["b", "a", "c"]);
    expect(matrix.normal.agent_turn.candidates).toEqual(["a", "b", "c"]);
  });
});

describe("filterToolsForLocalMode", () => {
  const tool = (name: string): AutomatonTool =>
    ({ name, description: "", parameters: {}, execute: async () => "", riskLevel: "safe", category: "vm" }) as AutomatonTool;

  it("removes cloud-only tools and keeps local ones", () => {
    const tools = [tool("exec"), tool("write_file"), tool("register_domain"), tool("spawn_child")];
    const filtered = filterToolsForLocalMode(tools).map((t) => t.name);
    expect(filtered).toEqual(["exec", "write_file"]);
  });

  it("keeps everything when the operator opts back in", () => {
    process.env.AUTOMATON_LOCAL_ALLOW_CLOUD_TOOLS = "1";
    const tools = [tool("exec"), tool("register_domain")];
    expect(filterToolsForLocalMode(tools)).toHaveLength(2);
  });

  it("does not filter tools the local machine can actually run", () => {
    for (const kept of ["exec", "read_file", "git_commit", "update_soul", "remember_fact", "enter_low_compute"]) {
      expect(CLOUD_ONLY_TOOLS).not.toContain(kept);
    }
  });
});
