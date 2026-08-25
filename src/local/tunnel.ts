/**
 * Public Reachability
 *
 * Until this existed, expose_port returned `http://localhost:8080` — true, and
 * useless: nothing the agent built could be reached by anyone, so it could not
 * be paid for anything either.
 *
 * Cloudflare quick tunnels are the default because they need no account, no
 * card and no DNS: cloudflared hands back an HTTPS hostname on a free
 * try-cloudflare domain. That is also their limitation — the hostname is random
 * and disappears when the process does, so it is fine for "here is where to
 * reach me today" and wrong for anything a customer should bookmark.
 *
 * ngrok is used instead when it is present and configured, since an operator
 * who set it up presumably wants it.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("tunnel");

const TUNNEL_READY_TIMEOUT_MS = 45_000;
const CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface Tunnel {
  publicUrl: string;
  port: number;
  provider: "cloudflare" | "ngrok";
  process: ChildProcess;
}

const active = new Map<number, Tunnel>();

export function getTunnel(port: number): Tunnel | undefined {
  return active.get(port);
}

export function closeTunnel(port: number): void {
  const tunnel = active.get(port);
  if (!tunnel) return;
  tunnel.process.kill("SIGTERM");
  active.delete(port);
  logger.info(`Closed ${tunnel.provider} tunnel for port ${port}`);
}

export function closeAllTunnels(): void {
  for (const port of [...active.keys()]) closeTunnel(port);
}

function binaryExists(name: string): boolean {
  // Statically imported: `require` is not defined in an ES module, and calling
  // it here threw a ReferenceError that the catch swallowed — reporting "no
  // tunnelling tool installed" on an image that had cloudflared all along.
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a tunnel and wait for its hostname.
 *
 * The URL is scraped from the process output because that is the only place a
 * quick tunnel reports it — there is no API to ask.
 */
async function startCloudflare(port: number): Promise<Tunnel> {
  const child = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const publicUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`cloudflared did not report a URL within ${TUNNEL_READY_TIMEOUT_MS / 1000}s`));
    }, TUNNEL_READY_TIMEOUT_MS);

    const scan = (chunk: Buffer) => {
      const match = chunk.toString("utf-8").match(CLOUDFLARE_URL_PATTERN);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with code ${code} before reporting a URL`));
    });
  });

  return { publicUrl, port, provider: "cloudflare", process: child };
}

async function startNgrok(port: number): Promise<Tunnel> {
  const child = spawn("ngrok", ["http", String(port), "--log", "stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // ngrok reports its URL through a local API rather than reliably on stdout.
  const deadline = Date.now() + TUNNEL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const resp = await fetch("http://127.0.0.1:4040/api/tunnels", {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { tunnels?: { public_url?: string; proto?: string }[] };
        const https = (data.tunnels ?? []).find((t) => t.public_url?.startsWith("https://"));
        if (https?.public_url) {
          return { publicUrl: https.public_url, port, provider: "ngrok", process: child };
        }
      }
    } catch {
      // Not up yet.
    }
  }

  child.kill("SIGTERM");
  throw new Error("ngrok did not report a public URL in time");
}

/**
 * Poll the tunnel hostname until it answers.
 *
 * Any HTTP response counts, including an error status: the question is whether
 * DNS and the edge are routing yet, not whether the service behind it is happy.
 */
async function waitUntilResolvable(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return false;
}

export interface ExposeResult {
  publicUrl: string;
  /** False when this is only reachable from the machine itself. */
  isPublic: boolean;
  detail: string;
}

/**
 * Make a local port reachable from the internet, if we can.
 *
 * Never throws: a failure returns the local URL with isPublic false, so the
 * caller can say plainly that the service is up but unreachable rather than
 * failing the whole operation.
 */
export async function exposePublicly(port: number): Promise<ExposeResult> {
  const existing = active.get(port);
  if (existing) {
    return {
      publicUrl: existing.publicUrl,
      isPublic: true,
      detail: `Existing ${existing.provider} tunnel.`,
    };
  }

  const disabled = (process.env.AUTOMATON_TUNNEL || "").trim().toLowerCase();
  if (disabled === "off" || disabled === "0") {
    return {
      publicUrl: `http://localhost:${port}`,
      isPublic: false,
      detail: "Tunnelling is switched off by your creator (AUTOMATON_TUNNEL=off).",
    };
  }

  const preferred = (process.env.AUTOMATON_TUNNEL_PROVIDER || "").trim().toLowerCase();
  const providers: (() => Promise<Tunnel>)[] = [];
  if (preferred === "ngrok" && binaryExists("ngrok")) providers.push(() => startNgrok(port));
  if (binaryExists("cloudflared")) providers.push(() => startCloudflare(port));
  if (preferred !== "ngrok" && binaryExists("ngrok")) providers.push(() => startNgrok(port));

  if (providers.length === 0) {
    return {
      publicUrl: `http://localhost:${port}`,
      isPublic: false,
      detail:
        "No tunnelling tool is installed, so this is only reachable from this machine. " +
        "cloudflared or ngrok would make it public.",
    };
  }

  for (const start of providers) {
    try {
      const tunnel = await start();
      active.set(port, tunnel);

      // The hostname exists before DNS knows about it. Handing it out during
      // that window gives whoever tries it NXDOMAIN, which reads as "this agent
      // is broken" rather than "wait five seconds".
      const resolved = await waitUntilResolvable(tunnel.publicUrl);

      logger.info(`Port ${port} is public at ${tunnel.publicUrl} via ${tunnel.provider}`);
      return {
        publicUrl: tunnel.publicUrl,
        isPublic: true,
        detail:
          `Reachable through ${tunnel.provider}. The hostname is temporary and changes if this ` +
          `tunnel restarts.` +
          (resolved ? "" : " DNS has not propagated yet; it may take a few more seconds to work."),
      };
    } catch (err: any) {
      logger.warn(`Tunnel attempt failed: ${err.message}`);
    }
  }

  return {
    publicUrl: `http://localhost:${port}`,
    isPublic: false,
    detail: "Every tunnel attempt failed; this is only reachable from this machine.",
  };
}
