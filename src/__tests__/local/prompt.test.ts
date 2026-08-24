/**
 * Local prompt sections.
 *
 * These guard against the failure that showed up on the first real boot: a
 * small local model reading the shared Conway prompt, concluding its job was to
 * review its finances and delegate to child agents, and doing nothing else.
 */

import { describe, it, expect } from "vitest";
import {
  buildDonationSection,
  buildLocalClosingReminder,
  buildLocalEnvironmentSection,
  buildLocalFirstWakeup,
  buildLocalOperationalContext,
  buildLocalWakeup,
} from "../../local/prompt.js";
import type { LocalModeSettings } from "../../local/mode.js";

const settings: LocalModeSettings = {
  inferenceBaseUrl: "http://127.0.0.1:11434",
  model: "qwen2.5:7b",
  apiKey: "local",
  workspaceDir: "/root",
  creditsCents: 1_000_000,
};

describe("local operational context", () => {
  const text = buildLocalOperationalContext(settings);

  it("does not tell the agent to delegate to agents that do not exist", () => {
    // Naming the absent tools is fine — instructing the agent to call them is
    // not. The cloud prompt's "create_goal and let an engineer agent do it" is
    // exactly what must not survive here.
    expect(text).not.toMatch(/call\s+create_goal|call\s+spawn_child/i);
    expect(text).not.toMatch(/let\s+an?\s+\w+\s+agent\s+do\s+it/i);
    expect(text).not.toMatch(/DO NOT write code yourself/i);
    expect(text).not.toMatch(/you are a parent orchestrator/i);
  });

  it("tells the agent to do the work itself", () => {
    expect(text).toMatch(/You\s+do\s+the\s+work\s+yourself/i);
  });

  it("does not describe credits, sandboxes or domains as available", () => {
    expect(text).toMatch(/no\s+sandboxes\s+to\s+rent,\s+no\s+child\s+agents,\s+no\s+domains,\s+no\s+credits/i);
  });

  it("keeps the parts that still apply locally", () => {
    expect(text).toMatch(/WORKLOG\.md/);
    expect(text).toMatch(/SOUL\.md/);
    expect(text).toMatch(/review_upstream_changes/);
  });

  it("is dramatically shorter than the cloud version it replaces", () => {
    // The shared OPERATIONAL_CONTEXT is ~19,000 characters. On CPU inference
    // every character is time, so this must stay small.
    expect(text.length).toBeLessThan(5_000);
  });
});

describe("local wake-up", () => {
  it("does not open a first turn by asking about money", () => {
    const text = buildLocalFirstWakeup({ name: "test", model: "qwen2.5:7b" });
    // Saying there is no balance is the point; asking it to go review one is
    // the bug this replaced.
    expect(text).not.toMatch(/review\s+your\s+financial\s+situation/i);
    expect(text).not.toMatch(/you have \$/i);
    expect(text).not.toMatch(/USDC/i);
    expect(text).toMatch(/no\s+balance\s+to\s+check/i);
    expect(text).toMatch(/WORKLOG\.md/);
  });

  it("passes the creator's message through when there is one", () => {
    const text = buildLocalFirstWakeup({
      name: "test",
      model: "qwen2.5:7b",
      creatorMessage: "start small",
    });
    expect(text).toContain("start small");
  });

  it("points a returning agent at its worklog rather than its balance", () => {
    const text = buildLocalWakeup({ turnCount: 5, lastTurnSummary: "did a thing", model: "m" });
    expect(text).toMatch(/WORKLOG\.md/);
    expect(text).not.toMatch(/credits|USDC/i);
    expect(text).toContain("did a thing");
  });
});

describe("local environment section", () => {
  const text = buildLocalEnvironmentSection(settings);

  it("states plainly that it overrides the conflicting text above it", () => {
    expect(text).toMatch(/OVERRIDES\s+ANY\s+CONFLICTING\s+TEXT\s+ABOVE/i);
  });

  it("tells the agent its survival tier is inert", () => {
    expect(text).toMatch(/cannot\s+run\s+out\s+of\s+credits|cannot\s+die/i);
  });

  it("names the model and endpoint actually in use", () => {
    expect(text).toContain("qwen2.5:7b");
    expect(text).toContain("http://127.0.0.1:11434");
  });

  it("closes with a short reminder that repeats the essentials", () => {
    const reminder = buildLocalClosingReminder(settings);
    expect(reminder).toContain("qwen2.5:7b");
    expect(reminder.length).toBeLessThan(500);
  });
});

describe("donation section", () => {
  const text = buildDonationSection({
    defaultSharePercent: 1,
    minSharePercent: 0,
    maxSharePercent: 10,
    minDonationXmr: "0.001",
    cooldownMinutes: 60,
  });

  it("states the share is the agent's to choose, within bounds", () => {
    expect(text).toMatch(/between 0% and 10%/);
    expect(text).toMatch(/1% is the default/);
  });

  it("tells the agent the destination is fixed and injection-proof", () => {
    expect(text).toMatch(/cannot\s+change:\s+the\s+destination/i);
    expect(text).toMatch(/attempt\s+to\s+rob\s+your\s+creator/i);
  });

  it("does not imply anything is sent automatically", () => {
    // Newline-tolerant: the prompt is hard-wrapped, so a literal space would
    // make this assertion about formatting rather than content.
    expect(text).toMatch(/Nothing\s+is\s+sent\s+unless\s+you\s+call\s+the\s+tool/i);
  });
});
