/**
 * Vast API client, against a mocked fetch.
 *
 * There is no account behind this yet, so these pin the client to the API shape
 * documented at docs.vast.ai: POST /bundles/ to search, PUT /asks/{id}/ to
 * rent, DELETE /instances/{id}/ to destroy, and new_contract as the id of what
 * you just rented.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { VastClient, VastApiError } from "../../vast/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, options: any) => { status?: number; body: unknown }) {
  const calls: { url: string; options: any }[] = [];
  globalThis.fetch = vi.fn(async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    const { status = 200, body } = handler(String(url), options);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as any;
  return calls;
}

const client = () => new VastClient({ apiKey: "test-key" });

describe("authentication", () => {
  it("sends the API key as a bearer token", async () => {
    const calls = mockFetch(() => ({ body: { balance: 12.5 } }));
    await client().getBalance();
    expect(calls[0].options.headers.Authorization).toBe("Bearer test-key");
  });
});

describe("searching offers", () => {
  it("posts filters to /bundles/ and normalizes the response", async () => {
    const calls = mockFetch(() => ({
      body: {
        offers: [
          { id: 42, gpu_name: "RTX_4090", num_gpus: 1, gpu_ram: 24576, dph_total: 0.35, disk_space: 200, reliability: 0.99 },
        ],
      },
    }));

    const offers = await client().searchOffers({
      gpuNames: ["RTX_4090"],
      minGpuRamMb: 24_000,
      maxDollarsPerHour: 0.6,
    });

    expect(calls[0].url).toContain("/bundles/");
    const body = JSON.parse(calls[0].options.body);
    expect(body.rentable).toEqual({ eq: true });
    expect(body.dph_total).toEqual({ lte: 0.6 });
    expect(body.gpu_name).toEqual({ in: ["RTX_4090"] });
    expect(body.gpu_ram).toEqual({ gte: 24_000 });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ id: 42, gpuName: "RTX_4090", dphTotal: 0.35 });
  });

  it("returns an empty list rather than throwing when nothing matches", async () => {
    mockFetch(() => ({ body: {} }));
    expect(await client().searchOffers({ maxDollarsPerHour: 0.1 })).toEqual([]);
  });
});

describe("renting", () => {
  it("PUTs to /asks/{offer}/ and returns new_contract", async () => {
    const calls = mockFetch(() => ({ body: { success: true, new_contract: 987 } }));
    const id = await client().createInstance({
      offerId: 42,
      image: "vllm/vllm-openai:latest",
      diskGb: 80,
      env: { "-p 8000:8000": "1" },
      args: ["--model", "some/model"],
      label: "test",
    });

    expect(id).toBe(987);
    expect(calls[0].url).toContain("/asks/42/");
    expect(calls[0].options.method).toBe("PUT");
    const body = JSON.parse(calls[0].options.body);
    expect(body.image).toBe("vllm/vllm-openai:latest");
    expect(body.disk).toBe(80);
    expect(body.args).toEqual(["--model", "some/model"]);
    expect(body.target_state).toBe("running");
  });

  it("throws when the rental succeeds but returns no id", async () => {
    mockFetch(() => ({ body: { success: true } }));
    await expect(
      client().createInstance({ offerId: 1, image: "x", diskGb: 10 }),
    ).rejects.toThrow(/no instance id/i);
  });

  it("surfaces the status code on failure", async () => {
    mockFetch(() => ({ status: 402, body: { error: "insufficient credit" } }));
    await expect(
      client().createInstance({ offerId: 1, image: "x", diskGb: 10 }),
    ).rejects.toMatchObject({ status: 402 });
  });
});

describe("dry run", () => {
  it("spends nothing and returns a sentinel id", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    const dry = new VastClient({ apiKey: "k", dryRun: true });
    const id = await dry.createInstance({ offerId: 1, image: "x", diskGb: 10 });
    expect(id).toBeLessThan(0);
    expect(calls).toHaveLength(0); // no request was made at all
  });

  it("does not call destroy either", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    await new VastClient({ apiKey: "k", dryRun: true }).destroyInstance(5);
    expect(calls).toHaveLength(0);
  });
});

describe("destroying", () => {
  it("treats an already-gone instance as success", async () => {
    mockFetch(() => ({ status: 404, body: { error: "not found" } }));
    // The idle reaper must never get stuck on an instance it cannot remove.
    await expect(client().destroyInstance(5)).resolves.toBeUndefined();
  });

  it("still raises other errors", async () => {
    mockFetch(() => ({ status: 500, body: { error: "boom" } }));
    await expect(client().destroyInstance(5)).rejects.toBeInstanceOf(VastApiError);
  });
});

describe("endpoints", () => {
  it("builds a URL from the public IP and mapped host port", () => {
    const endpoint = VastClient.endpointFor(
      {
        id: 1,
        actualStatus: "running",
        imageUuid: "",
        publicIp: "203.0.113.7",
        ports: { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "41234" }] },
        dphTotal: 0.3,
        gpuName: "RTX_4090",
        numGpus: 1,
      },
      8000,
    );
    expect(endpoint).toBe("http://203.0.113.7:41234");
  });

  it("returns null before the port has been mapped", () => {
    expect(
      VastClient.endpointFor(
        { id: 1, actualStatus: "loading", imageUuid: "", dphTotal: 0.3, gpuName: "x", numGpus: 1 },
        8000,
      ),
    ).toBeNull();
  });
});
