/**
 * Vast.ai API Client
 *
 * Talks to Vast's GPU marketplace REST API: search for offers, rent one, watch
 * it come up, destroy it. Used for two things — renting a bigger model to think
 * with, and renting a machine for a child automaton to live on.
 *
 * Every call here can cost real money, so the client carries a dry-run mode
 * that logs what it would do and returns plausible fakes instead of spending.
 * Budget enforcement lives in spend.ts and runs above this layer.
 *
 * API shape: https://docs.vast.ai/api-reference
 */

import { createLogger } from "../observability/logger.js";

const logger = createLogger("vast");

export const VAST_API_BASE = "https://console.vast.ai/api/v0";
const REQUEST_TIMEOUT_MS = 30_000;

export class VastApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VastApiError";
  }
}

/** An offer is a machine that can be rented, at a price. */
export interface VastOffer {
  id: number;
  gpuName: string;
  numGpus: number;
  gpuRamMb: number;
  /** Total dollars per hour, all-in. */
  dphTotal: number;
  diskSpaceGb: number;
  reliability: number;
  cudaMaxGood: number;
  geolocation: string;
  /** Down/up Mbps, when reported — model weights are a big download. */
  inetDown?: number;
}

export interface VastInstance {
  id: number;
  /** "loading" | "running" | "exited" | "offline" | ... */
  actualStatus: string;
  imageUuid: string;
  label?: string;
  publicIp?: string;
  /** Docker port map, e.g. { "8000/tcp": [{ HostIp, HostPort }] } */
  ports?: Record<string, { HostIp: string; HostPort: string }[]>;
  dphTotal: number;
  gpuName: string;
  numGpus: number;
  /** Unix seconds. */
  startDate?: number;
}

export interface OfferSearchCriteria {
  /** Acceptable GPU model names, e.g. ["RTX_4090", "A100_PCIE"]. */
  gpuNames?: string[];
  minGpuRamMb?: number;
  numGpus?: number;
  maxDollarsPerHour: number;
  minDiskGb?: number;
  minReliability?: number;
  minCudaVersion?: number;
  minInetDownMbps?: number;
  limit?: number;
}

export interface CreateInstanceParams {
  offerId: number;
  image: string;
  diskGb: number;
  /** Env vars and Docker port mappings, e.g. { OPEN_BUTTON_PORT: "8000", "-p 8000:8000": "1" }. */
  env?: Record<string, string>;
  onstart?: string;
  /** Entrypoint arguments, used to configure the vLLM server. */
  args?: string[];
  label?: string;
  /** Bid price per hour. Omit to take the offer's asking price. */
  price?: number;
}

export interface VastClientOptions {
  apiKey: string;
  /** Log intended actions and return fakes rather than spending money. */
  dryRun?: boolean;
  apiBase?: string;
}

export class VastClient {
  private readonly apiBase: string;

  constructor(private readonly options: VastClientOptions) {
    this.apiBase = (options.apiBase || VAST_API_BASE).replace(/\/$/, "");
  }

  get isDryRun(): boolean {
    return this.options.dryRun === true;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new VastApiError(`Vast API unreachable (${method} ${path}): ${err.message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new VastApiError(
        `Vast API ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  /** Account balance in dollars. */
  async getBalance(): Promise<number> {
    const result = await this.request<{ balance?: number; credit?: number }>(
      "GET",
      "/users/current",
    );
    return result.balance ?? result.credit ?? 0;
  }

  /**
   * Search rentable offers, cheapest first.
   *
   * Vast's filter syntax is one object per field with a comparison operator,
   * e.g. { dph_total: { lte: 0.5 } }.
   */
  async searchOffers(criteria: OfferSearchCriteria): Promise<VastOffer[]> {
    const query: Record<string, unknown> = {
      rentable: { eq: true },
      dph_total: { lte: criteria.maxDollarsPerHour },
      num_gpus: { eq: criteria.numGpus ?? 1 },
      order: [["dph_total", "asc"]],
      type: "on-demand",
      limit: criteria.limit ?? 20,
    };

    if (criteria.gpuNames?.length) query.gpu_name = { in: criteria.gpuNames };
    if (criteria.minGpuRamMb) query.gpu_ram = { gte: criteria.minGpuRamMb };
    if (criteria.minDiskGb) query.disk_space = { gte: criteria.minDiskGb };
    if (criteria.minReliability) query.reliability = { gte: criteria.minReliability };
    if (criteria.minCudaVersion) query.cuda_max_good = { gte: criteria.minCudaVersion };
    if (criteria.minInetDownMbps) query.inet_down = { gte: criteria.minInetDownMbps };

    const result = await this.request<{ offers?: any[] }>("POST", "/bundles/", query);
    return (result.offers ?? []).map(normalizeOffer);
  }

  /**
   * Rent an offer. Returns the new instance id ("contract" in Vast's terms).
   *
   * In dry-run this spends nothing and returns a negative id, which every
   * downstream path treats as "not a real instance".
   */
  async createInstance(params: CreateInstanceParams): Promise<number> {
    const body: Record<string, unknown> = {
      client_id: "me",
      image: params.image,
      disk: params.diskGb,
      runtype: "args",
      target_state: "running",
      cancel_unavail: true,
    };
    if (params.env) body.env = params.env;
    if (params.onstart) body.onstart = params.onstart;
    if (params.args) body.args = params.args;
    if (params.label) body.label = params.label;
    if (params.price !== undefined) body.price = params.price;

    if (this.isDryRun) {
      logger.info(
        `[DRY RUN] Would rent offer ${params.offerId}: image=${params.image} disk=${params.diskGb}GB ` +
          `label=${params.label ?? "(none)"} args=${JSON.stringify(params.args ?? [])}`,
      );
      return -1;
    }

    const result = await this.request<{ success?: boolean; new_contract?: number }>(
      "PUT",
      `/asks/${params.offerId}/`,
      body,
    );
    if (!result.new_contract) {
      throw new VastApiError(`Vast accepted the rental but returned no instance id`);
    }
    logger.info(`Rented Vast instance ${result.new_contract} from offer ${params.offerId}`);
    return result.new_contract;
  }

  async getInstance(instanceId: number): Promise<VastInstance | null> {
    if (this.isDryRun && instanceId < 0) return null;
    const result = await this.request<{ instances?: any }>(
      "GET",
      `/instances/${instanceId}/`,
    );
    // Vast returns either a bare object or a single-element collection here.
    const raw = Array.isArray(result.instances) ? result.instances[0] : result.instances;
    return raw ? normalizeInstance(raw) : null;
  }

  async listInstances(): Promise<VastInstance[]> {
    if (this.isDryRun) return [];
    const result = await this.request<{ instances?: any[] }>("GET", "/instances/");
    return (result.instances ?? []).map(normalizeInstance);
  }

  /**
   * Destroy an instance and stop the billing.
   *
   * Deliberately tolerant: a destroy that fails because the instance is already
   * gone is a success for our purposes, and the idle reaper must never get stuck
   * retrying one it cannot remove.
   */
  async destroyInstance(instanceId: number): Promise<void> {
    if (this.isDryRun) {
      logger.info(`[DRY RUN] Would destroy instance ${instanceId}`);
      return;
    }
    try {
      await this.request("DELETE", `/instances/${instanceId}/`);
      logger.info(`Destroyed Vast instance ${instanceId}`);
    } catch (err) {
      if (err instanceof VastApiError && err.status === 404) {
        logger.info(`Vast instance ${instanceId} already gone`);
        return;
      }
      throw err;
    }
  }

  /** Public base URL for a port exposed by an instance, or null if not mapped yet. */
  static endpointFor(instance: VastInstance, containerPort: number): string | null {
    const mapping = instance.ports?.[`${containerPort}/tcp`];
    const hostPort = mapping?.[0]?.HostPort;
    if (!instance.publicIp || !hostPort) return null;
    return `http://${instance.publicIp}:${hostPort}`;
  }
}

function normalizeOffer(raw: any): VastOffer {
  return {
    id: raw.id,
    gpuName: raw.gpu_name ?? "unknown",
    numGpus: raw.num_gpus ?? 1,
    gpuRamMb: raw.gpu_ram ?? 0,
    dphTotal: raw.dph_total ?? 0,
    diskSpaceGb: raw.disk_space ?? 0,
    reliability: raw.reliability ?? raw.reliability2 ?? 0,
    cudaMaxGood: raw.cuda_max_good ?? 0,
    geolocation: raw.geolocation ?? "",
    inetDown: raw.inet_down,
  };
}

function normalizeInstance(raw: any): VastInstance {
  return {
    id: raw.id,
    actualStatus: raw.actual_status ?? raw.cur_state ?? "unknown",
    imageUuid: raw.image_uuid ?? "",
    label: raw.label ?? undefined,
    publicIp: raw.public_ipaddr ?? undefined,
    ports: raw.ports ?? undefined,
    dphTotal: raw.dph_total ?? 0,
    gpuName: raw.gpu_name ?? "unknown",
    numGpus: raw.num_gpus ?? 1,
    startDate: raw.start_date ?? undefined,
  };
}
