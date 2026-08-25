/**
 * Local Host Client
 *
 * A ConwayClient implementation backed by the machine the runtime is running
 * on. Shell commands, file I/O and port exposure happen here; everything that
 * only the Conway control plane can do (renting sandboxes, moving credits,
 * registering domains) reports itself as unavailable rather than failing with
 * an opaque network error.
 *
 * The security boundary in local mode is the container or VM you run this in,
 * not a remote sandbox. Read the Security section of README.md before running
 * it on a host you care about.
 */

import { spawn } from "child_process";
import fs from "fs";
import nodePath from "path";
import type {
  ConwayClient,
  CreateSandboxOptions,
  CreditTransferResult,
  DnsRecord,
  DomainRegistration,
  DomainSearchResult,
  ExecResult,
  ModelInfo,
  PortInfo,
  PricingTier,
  SandboxInfo,
} from "../types.js";
import { createLogger } from "../observability/logger.js";
import { closeTunnel, exposePublicly } from "./tunnel.js";

const logger = createLogger("local-client");

/** Matches the remote client's maxBuffer so output limits behave the same. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Exit code convention for a timed-out command, as `timeout(1)` uses. */
const TIMEOUT_EXIT_CODE = 124;

export interface LocalClientOptions {
  /** Working directory for exec and for resolving relative paths. */
  workspaceDir: string;
  /** Base URL of the local inference server, used for model discovery. */
  inferenceBaseUrl: string;
  /** Synthetic balance to report to the survival system. */
  creditsCents: number;
}

function unavailable(capability: string): Error {
  return new Error(
    `${capability} is unavailable in local mode: this automaton runs on local ` +
      `hardware with no Conway control plane. Work with the tools you have on ` +
      `this machine instead.`,
  );
}

export function createLocalClient(options: LocalClientOptions): ConwayClient {
  const { workspaceDir, inferenceBaseUrl, creditsCents } = options;

  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  const resolveLocalPath = (filePath: string): string => {
    if (filePath.startsWith("~")) {
      return nodePath.join(process.env.HOME || workspaceDir, filePath.slice(1));
    }
    return nodePath.resolve(workspaceDir, filePath);
  };

  /**
   * Run a shell command on this machine.
   *
   * Uses spawn rather than execSync so a long-running command cannot block the
   * event loop — the heartbeat daemon has to keep ticking while the agent's
   * command runs.
   */
  const exec = (command: string, timeout?: number): Promise<ExecResult> =>
    new Promise((resolve) => {
      const limitMs = timeout && timeout > 0 ? timeout : DEFAULT_EXEC_TIMEOUT_MS;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn("/bin/sh", ["-c", command], {
        cwd: workspaceDir,
        env: process.env,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, limitMs);

      const append = (buffer: string, chunk: Buffer): string =>
        buffer.length >= MAX_OUTPUT_BYTES
          ? buffer
          : (buffer + chunk.toString("utf-8")).slice(0, MAX_OUTPUT_BYTES);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      const settle = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: timedOut
            ? `${stderr}\n[local] command killed after ${limitMs}ms timeout`
            : stderr,
          exitCode,
        });
      };

      child.on("error", (err: Error) => {
        stderr = `${stderr}${err.message}`;
        settle(127);
      });

      child.on("close", (code, signal) => {
        if (timedOut) return settle(TIMEOUT_EXIT_CODE);
        if (code === null) {
          stderr = `${stderr}\n[local] command terminated by signal ${signal}`;
          return settle(1);
        }
        settle(code);
      });
    });

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    const resolved = resolveLocalPath(filePath);
    const dir = nodePath.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> =>
    fs.readFileSync(resolveLocalPath(filePath), "utf-8");

  /**
   * Make a port reachable from outside this machine.
   *
   * Returns the local URL when no tunnel could be opened rather than failing,
   * so a service still starts and the caller can say plainly that it is up but
   * unreachable. See src/local/tunnel.ts.
   */
  const exposePort = async (port: number): Promise<PortInfo> => {
    const result = await exposePublicly(port);
    if (!result.isPublic) {
      logger.warn(`Port ${port} is not publicly reachable: ${result.detail}`);
    }
    return { port, publicUrl: result.publicUrl, sandboxId: "local" };
  };

  const removePort = async (port: number): Promise<void> => {
    closeTunnel(port);
  };

  /**
   * Model discovery against the local endpoint. Tries Ollama's native /api/tags
   * first, then the OpenAI-compatible /v1/models so vLLM, llama.cpp and LM
   * Studio also report their models.
   */
  const listModels = async (): Promise<ModelInfo[]> => {
    const base = inferenceBaseUrl.replace(/\/$/, "");
    const freePricing = { inputPerMillion: 0, outputPerMillion: 0 };

    try {
      const resp = await fetch(`${base}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { models?: { name?: string; model?: string }[] };
        const models = (data.models ?? [])
          .map((m) => m.name || m.model)
          .filter((id): id is string => !!id);
        if (models.length > 0) {
          return models.map((id) => ({ id, provider: "ollama", pricing: freePricing }));
        }
      }
    } catch {
      // Not an Ollama server, or not up yet — fall through to /v1/models.
    }

    try {
      const resp = await fetch(`${base}/v1/models`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { data?: { id?: string }[] };
        return (data.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => !!id)
          .map((id) => ({ id, provider: "local", pricing: freePricing }));
      }
    } catch (err: any) {
      logger.warn(`Local inference server not reachable at ${base}: ${err.message}`);
    }

    return [];
  };

  return {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,

    // ── Conway control-plane operations ────────────────────────
    // These exist only in the cloud. They report themselves as unavailable so
    // the agent gets a sentence it can reason about instead of a stack trace.

    createSandbox: async (_options: CreateSandboxOptions): Promise<SandboxInfo> => {
      throw unavailable("Renting a sandbox");
    },
    deleteSandbox: async (): Promise<void> => {},
    listSandboxes: async (): Promise<SandboxInfo[]> => [],

    getCreditsBalance: async (): Promise<number> => creditsCents,
    getCreditsPricing: async (): Promise<PricingTier[]> => [],
    transferCredits: async (): Promise<CreditTransferResult> => {
      throw unavailable("Transferring credits");
    },

    /**
     * Identity registration is a Conway API call. Locally the wallet on disk is
     * the identity; there is nobody to register it with.
     */
    registerAutomaton: async (params: {
      automatonId: string;
      automatonAddress: string;
    }): Promise<{ automaton: Record<string, unknown> }> => ({
      automaton: {
        id: params.automatonId,
        address: params.automatonAddress,
        registry: "local",
      },
    }),

    searchDomains: async (): Promise<DomainSearchResult[]> => {
      throw unavailable("Domain search");
    },
    registerDomain: async (): Promise<DomainRegistration> => {
      throw unavailable("Domain registration");
    },
    listDnsRecords: async (): Promise<DnsRecord[]> => {
      throw unavailable("DNS management");
    },
    addDnsRecord: async (): Promise<DnsRecord> => {
      throw unavailable("DNS management");
    },
    deleteDnsRecord: async (): Promise<void> => {
      throw unavailable("DNS management");
    },

    listModels,

    /** There are no other sandboxes to scope to; every path leads back here. */
    createScopedClient: (): ConwayClient => createLocalClient(options),
  };
}
