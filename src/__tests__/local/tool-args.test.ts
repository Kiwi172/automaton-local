/**
 * Tool argument validation.
 *
 * Observed on real hardware: qwen2.5:7b called `exec` with {path, content}
 * instead of {command}. The tool body then did `command.includes(...)` on
 * undefined and the model received "Cannot read properties of undefined
 * (reading 'includes')" — an error it has no way to act on, so it repeated the
 * same malformed call. Small models get argument names wrong often enough that
 * the failure mode matters more than the failure.
 */

import { describe, it, expect } from "vitest";
import { createBuiltinTools, validateRequiredArgs } from "../../agent/tools.js";
import type { AutomatonTool } from "../../types.js";

function findTool(name: string): AutomatonTool {
  const tool = createBuiltinTools("").find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

describe("validateRequiredArgs", () => {
  it("names the missing argument, what the tool takes, and what was sent", () => {
    const error = validateRequiredArgs(findTool("exec"), {
      path: "/root/hello.txt",
      content: "hi",
    });
    expect(error).toContain("command");
    expect(error).toContain("This tool accepts");
    expect(error).toContain("You passed: path, content");
  });

  it("accepts a correct call", () => {
    expect(validateRequiredArgs(findTool("exec"), { command: "echo hi" })).toBeNull();
  });

  it("treats an explicit null as missing", () => {
    expect(validateRequiredArgs(findTool("exec"), { command: null })).toContain("command");
  });

  it("reports every missing argument at once, not one per round trip", () => {
    const error = validateRequiredArgs(findTool("write_file"), {});
    expect(error).toContain("path");
    expect(error).toContain("content");
  });

  it("passes tools that require nothing", () => {
    expect(validateRequiredArgs(findTool("system_synopsis"), {})).toBeNull();
  });

  it("ignores extra arguments the tool did not ask for", () => {
    expect(
      validateRequiredArgs(findTool("exec"), { command: "ls", nonsense: 1 }),
    ).toBeNull();
  });
});

describe("the crash this prevents", () => {
  it("exec no longer throws on a malformed call", async () => {
    const tool = findTool("exec");
    // Before validation this threw TypeError from isForbiddenCommand.
    const error = validateRequiredArgs(tool, { path: "/root/x", content: "y" });
    expect(error).not.toBeNull();
    expect(error).not.toMatch(/Cannot read properties/);
  });
});
