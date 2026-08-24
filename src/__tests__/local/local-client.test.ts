/**
 * Local host client: real command execution, real file I/O, and clear refusals
 * for the control-plane operations that do not exist locally.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createLocalClient } from "../../local/local-client.js";

let workspace: string;
let client: ReturnType<typeof createLocalClient>;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-local-"));
  client = createLocalClient({
    workspaceDir: workspace,
    inferenceBaseUrl: "http://127.0.0.1:11434",
    creditsCents: 1_000_000,
  });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("exec", () => {
  it("returns stdout and a zero exit code", async () => {
    const result = await client.exec("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("reports stderr and the real exit code instead of throwing", async () => {
    const result = await client.exec("echo oops >&2; exit 3");
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(3);
  });

  it("runs in the workspace directory", async () => {
    const result = await client.exec("pwd");
    expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(workspace));
  });

  it("kills a command that outruns its timeout and says so", async () => {
    const result = await client.exec("sleep 5", 300);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timeout");
  });

  it("does not block the event loop while a command runs", async () => {
    // execSync would starve the heartbeat daemon; spawn must not.
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 50);
    await client.exec("sleep 0.4");
    clearTimeout(timer);
    expect(ticked).toBe(true);
  });

  it("survives a command that does not exist", async () => {
    const result = await client.exec("definitely-not-a-real-binary-xyz");
    expect(result.exitCode).not.toBe(0);
  });
});

describe("files", () => {
  it("round-trips a file through the workspace", async () => {
    await client.writeFile("notes/today.md", "written by the agent");
    expect(await client.readFile("notes/today.md")).toBe("written by the agent");
    expect(fs.existsSync(path.join(workspace, "notes/today.md"))).toBe(true);
  });

  it("creates parent directories", async () => {
    await client.writeFile("a/b/c/deep.txt", "x");
    expect(fs.existsSync(path.join(workspace, "a/b/c/deep.txt"))).toBe(true);
  });

  it("resolves relative paths against the workspace, not the process cwd", async () => {
    await client.writeFile("rel.txt", "x");
    expect(fs.existsSync(path.join(workspace, "rel.txt"))).toBe(true);
  });
});

describe("ports", () => {
  it("reports a localhost URL, since there is no ingress to configure", async () => {
    const info = await client.exposePort(8080);
    expect(info.publicUrl).toBe("http://localhost:8080");
    await expect(client.removePort(8080)).resolves.toBeUndefined();
  });
});

describe("credits", () => {
  it("reports the configured synthetic balance so the survival tier stays high", async () => {
    expect(await client.getCreditsBalance()).toBe(1_000_000);
  });
});

describe("control-plane operations", () => {
  it("refuses sandbox rental with an explanation the agent can read", async () => {
    await expect(client.createSandbox({})).rejects.toThrow(/local mode/i);
  });

  it("refuses credit transfers", async () => {
    await expect(client.transferCredits("0xabc", 100)).rejects.toThrow(/local mode/i);
  });

  it("refuses domain operations", async () => {
    await expect(client.searchDomains("example")).rejects.toThrow(/local mode/i);
    await expect(client.registerDomain("example.com")).rejects.toThrow(/local mode/i);
  });

  it("reports no sandboxes rather than failing a listing", async () => {
    expect(await client.listSandboxes()).toEqual([]);
  });

  it("treats identity registration as a local no-op", async () => {
    const result = await client.registerAutomaton({
      automatonId: "abc",
      automatonAddress: "0xdead",
    } as any);
    expect(result.automaton.registry).toBe("local");
  });

  it("scopes back to itself, since there are no other machines", async () => {
    const scoped = client.createScopedClient("whatever");
    expect(await scoped.getCreditsBalance()).toBe(1_000_000);
  });
});
