/**
 * Loop detection in the main agent loop.
 *
 * Reproduces the failure observed on real hardware: qwen2.5:7b finished its
 * task, then rewrote the same file for six more turns. The loop's existing
 * detection keys on the sorted set of tool *names* and needs three identical
 * patterns in a row, so the observed sequence — write_file x2, x1, x1, x2 —
 * broke the streak every turn and nothing fired. Locally there is no credit
 * balance to run out of either, so it would have continued indefinitely.
 */

import { describe, it, expect } from "vitest";
import { LoopDetector } from "../../agent/loop-detector.js";

const SAME_ARGS = JSON.stringify({
  path: "~/hello.txt",
  content: "I am an automaton named testbot created by local operator.",
});

describe("the observed loop", () => {
  it("is caught by argument hashing where name-pattern tracking missed it", () => {
    const detector = new LoopDetector({ escapeHatchTool: "sleep" });
    expect(detector.recordToolCall("write_file", SAME_ARGS).blocked).toBe(false);
    expect(detector.recordToolCall("write_file", SAME_ARGS).blocked).toBe(false);
    // Third identical call — this is the one that would have kept going.
    const third = detector.recordToolCall("write_file", SAME_ARGS);
    expect(third.blocked).toBe(true);
    expect(third.reason).toMatch(/identical arguments/i);
  });

  it("survives the varying calls-per-turn that defeated the old check", () => {
    const detector = new LoopDetector({ escapeHatchTool: "sleep" });
    // write_file x2, then x1, then x1 — the real sequence.
    detector.recordToolCall("write_file", SAME_ARGS);
    detector.recordToolCall("write_file", SAME_ARGS);
    detector.endTurn();
    const blocked = detector.recordToolCall("write_file", SAME_ARGS);
    expect(blocked.blocked).toBe(true);
  });

  it("does not block the same tool used on different arguments", () => {
    const detector = new LoopDetector({ escapeHatchTool: "sleep" });
    for (const path of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      const check = detector.recordToolCall("write_file", JSON.stringify({ path }));
      expect(check.blocked).toBe(false);
    }
  });

  it("does not block alternating tools", () => {
    const detector = new LoopDetector({ escapeHatchTool: "sleep" });
    for (let i = 0; i < 4; i++) {
      expect(detector.recordToolCall("read_file", SAME_ARGS).blocked).toBe(false);
      expect(detector.recordToolCall("write_file", SAME_ARGS).blocked).toBe(false);
    }
  });
});

describe("escape hatch naming", () => {
  it("points the main loop's agent at sleep, a tool it actually has", () => {
    const detector = new LoopDetector({ escapeHatchTool: "sleep" });
    detector.recordToolCall("exec", "{}");
    detector.recordToolCall("exec", "{}");
    const blocked = detector.recordToolCall("exec", "{}");
    expect(blocked.reason).toContain("sleep");
    // task_done belongs to the harness agents; naming it here would tell the
    // automaton to call a tool that is not in its list.
    expect(blocked.reason).not.toContain("task_done");
  });

  it("still defaults to task_done for the harness callers", () => {
    const detector = new LoopDetector();
    detector.recordToolCall("exec", "{}");
    detector.recordToolCall("exec", "{}");
    expect(detector.recordToolCall("exec", "{}").reason).toContain("task_done");
  });

  it("uses the configured tool in turn-level messages too", () => {
    const detector = new LoopDetector({ escapeHatchTool: "sleep" });
    for (let turn = 0; turn < 3; turn++) {
      detector.recordToolCall("write_file", JSON.stringify({ path: `f${turn}.txt` }));
      var result = detector.endTurn();
    }
    expect(result!.reason).toContain("sleep");
    expect(result!.reason).not.toContain("task_done");
  });
});

describe("recovery", () => {
  it("stops blocking once the agent changes what it is doing", () => {
    const detector = new LoopDetector({ escapeHatchTool: "sleep" });
    detector.recordToolCall("write_file", SAME_ARGS);
    detector.recordToolCall("write_file", SAME_ARGS);
    expect(detector.recordToolCall("write_file", SAME_ARGS).blocked).toBe(true);

    // A different action clears the streak, so a later legitimate repeat of the
    // original call is allowed rather than permanently banned.
    expect(detector.recordToolCall("exec", '{"command":"ls"}').blocked).toBe(false);
    expect(detector.recordToolCall("write_file", SAME_ARGS).blocked).toBe(false);
  });
});
