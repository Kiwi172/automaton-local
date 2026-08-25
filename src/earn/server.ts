/**
 * Job Intake Server
 *
 * The public face of the agent: a small HTTP service where a stranger can
 * describe what they want, get quoted, pay, and collect the result.
 *
 * Written against node:http with no framework, because this listens on the open
 * internet and every dependency here is attack surface for the sake of routing
 * four endpoints.
 *
 * Everything arriving is hostile until proven otherwise: bodies are capped,
 * requests are rate limited per address, and the request text is sanitized in
 * jobs.ts before it is stored, let alone shown to the model.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import { formatXmr } from "../local/monero/wallet-rpc.js";
import { JobRejected, createJob, getJob, listJobs } from "./jobs.js";

const logger = createLogger("intake");

const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

export interface IntakeOptions {
  db: BetterSqlite3.Database;
  port: number;
  /** Shown on the landing page so customers know what they are buying. */
  offer: string;
  agentName: string;
}

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Public view of a job. Deliberately omits internal notes and indices. */
function publicJob(job: NonNullable<ReturnType<typeof getJob>>) {
  return {
    id: job.id,
    status: job.status,
    created_at: job.createdAt,
    price_xmr: job.pricePiconero ? formatXmr(job.pricePiconero) : null,
    pay_to: job.paymentAddress,
    paid_xmr: job.paidPiconero > 0n ? formatXmr(job.paidPiconero) : null,
    result: job.result,
    note: job.note,
  };
}

export function startIntakeServer(options: IntakeOptions): Server {
  const { db, offer, agentName } = options;

  const server = createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (rateLimited(ip)) {
      json(res, 429, { error: "Too many requests. Try again in a minute." });
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "GET" && path === "/") {
        json(res, 200, {
          agent: agentName,
          offer,
          how_it_works: [
            "POST /jobs with {\"request\": \"what you want\", \"refund_address\": \"4...\"} to ask for work.",
            "GET /jobs/{id} to see the quote and the Monero address to pay.",
            "Pay that address. The address is unique to your job, so nothing else is needed.",
            "GET /jobs/{id} again to collect the result.",
          ],
          notes: [
            "This service is run by an autonomous agent, not a person.",
            "Include a refund_address so you can be refunded if the work is not done.",
            "Payment is in Monero (XMR).",
          ],
        });
        return;
      }

      if (req.method === "POST" && path === "/jobs") {
        const raw = await readBody(req);
        let parsed: any;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          json(res, 400, { error: "Body must be JSON." });
          return;
        }

        const request = typeof parsed.request === "string" ? parsed.request.trim() : "";
        if (request.length < 10) {
          json(res, 400, { error: "Describe what you want in at least 10 characters." });
          return;
        }

        try {
          const job = createJob(db, {
            request,
            contact: typeof parsed.contact === "string" ? parsed.contact : undefined,
            refundAddress:
              typeof parsed.refund_address === "string" ? parsed.refund_address : undefined,
          });
          logger.info(`Job ${job.id} submitted from ${ip}`);
          json(res, 201, {
            ...publicJob(job),
            message: "Received. Check back for a quote.",
          });
        } catch (err) {
          if (err instanceof JobRejected) {
            json(res, 400, { error: err.message });
            return;
          }
          throw err;
        }
        return;
      }

      if (req.method === "GET" && path.startsWith("/jobs/")) {
        const id = path.slice("/jobs/".length);
        const job = getJob(db, id);
        if (!job) {
          json(res, 404, { error: "No such job." });
          return;
        }
        json(res, 200, publicJob(job));
        return;
      }

      if (req.method === "GET" && path === "/jobs") {
        // Counts only — the queue length is useful to a customer deciding
        // whether to bother; other people's requests are not their business.
        const open = listJobs(db, { limit: 200 }).filter((j) =>
          ["requested", "quoted", "paid", "working"].includes(j.status),
        );
        json(res, 200, { open_jobs: open.length });
        return;
      }

      json(res, 404, { error: "Not found." });
    } catch (err: any) {
      logger.warn(`Intake error: ${err.message}`);
      json(res, 400, { error: "Bad request." });
    }
  });

  // Bind to all interfaces: the tunnel or port publish is what actually exposes
  // this, and binding to loopback would make it unreachable through either.
  server.listen(options.port, "0.0.0.0", () => {
    logger.info(`Job intake listening on :${options.port}`);
  });

  return server;
}
