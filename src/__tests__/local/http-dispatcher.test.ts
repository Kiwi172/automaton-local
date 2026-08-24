/**
 * Dispatcher pass-through.
 *
 * undici enforces a 300s headersTimeout underneath Node's global fetch, and no
 * AbortController or caller timeout can raise it. With stream:false the model
 * sends no headers until it has finished thinking, so a slow local model failed
 * at exactly five minutes with an opaque "fetch failed" — observed on real
 * hardware before this was fixed. The only lever is replacing the dispatcher.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { ResilientHttpClient } from "../../conway/http-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ResilientHttpClient dispatcher", () => {
  it("passes a dispatcher through to fetch when given one", async () => {
    const seen: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, options: any) => {
      seen.push(options);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const dispatcher = { marker: "test-dispatcher" };
    const client = new ResilientHttpClient({ maxRetries: 0 }, dispatcher);
    await client.request("https://example.com/v1/thing", { method: "GET" });

    expect(seen).toHaveLength(1);
    expect(seen[0].dispatcher).toBe(dispatcher);
  });

  it("omits the field entirely when no dispatcher is configured", async () => {
    const seen: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, options: any) => {
      seen.push(options);
      return new Response("{}", { status: 200 });
    }) as any;

    const client = new ResilientHttpClient({ maxRetries: 0 });
    await client.request("https://example.com/v1/thing", { method: "GET" });

    // Not merely undefined — absent, so Node's default handling is untouched
    // for every cloud-mode caller.
    expect("dispatcher" in seen[0]).toBe(false);
  });
});
