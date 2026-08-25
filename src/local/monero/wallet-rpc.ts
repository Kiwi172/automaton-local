/**
 * Monero Wallet RPC Client
 *
 * Talks to `monero-wallet-rpc` over JSON-RPC 2.0. That daemon holds the keys
 * and signs; this client only asks it for balances, addresses and transfers.
 *
 * All amounts are piconero (atomic units, 1 XMR = 1e12) and are handled as
 * BigInt throughout. Monero balances routinely exceed what a double can hold
 * exactly, and a rounding error here would be a rounding error in someone's
 * money.
 */

import { createLogger } from "../../observability/logger.js";

const logger = createLogger("monero");

export const PICONERO_PER_XMR = 1_000_000_000_000n;
const RPC_TIMEOUT_MS = 30_000;
/** Transfers can take a while to construct when the wallet has many outputs. */
const TRANSFER_TIMEOUT_MS = 120_000;

export interface MoneroTransfer {
  txHash: string;
  amountPiconero: bigint;
  feePiconero: bigint;
}

export interface MoneroBalance {
  balancePiconero: bigint;
  unlockedPiconero: bigint;
  /** Blocks until the next chunk of balance unlocks; 0 when all is spendable. */
  blocksToUnlock: number;
}

export interface IncomingTransfer {
  txHash: string;
  amountPiconero: bigint;
  height: number;
  timestamp: number;
  /** Subaddress index the funds landed on, when the wallet reports one. */
  subaddressIndex?: number;
  /** Confirmations so far. Zero means it is in the pool but not yet mined. */
  confirmations?: number;
}

export interface Subaddress {
  address: string;
  index: number;
}

export class MoneroRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "MoneroRpcError";
  }
}

/** Convert piconero to a human XMR string without going through a float. */
export function formatXmr(piconero: bigint, decimals = 12): string {
  const negative = piconero < 0n;
  const abs = negative ? -piconero : piconero;
  const whole = abs / PICONERO_PER_XMR;
  const frac = (abs % PICONERO_PER_XMR).toString().padStart(12, "0").slice(0, decimals);
  const trimmed = frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmed ? "." + trimmed : ""}`;
}

/**
 * Parse an XMR amount string into piconero without floating point.
 * Rejects anything that is not a plain decimal number.
 */
export function parseXmr(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid XMR amount: "${value}"`);
  }
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 12) {
    throw new Error(`XMR amounts have at most 12 decimal places, got ${frac.length}`);
  }
  return BigInt(whole) * PICONERO_PER_XMR + BigInt(frac.padEnd(12, "0") || "0");
}

export interface MoneroWalletRpcOptions {
  /** Base URL of monero-wallet-rpc, e.g. http://monero-wallet:18082 */
  url: string;
  /** Wallet file name inside the daemon's --wallet-dir. */
  walletName: string;
  walletPassword: string;
  /** Optional HTTP digest credentials, if the daemon was not started with --disable-rpc-login. */
  rpcUsername?: string;
  rpcPassword?: string;
}

export class MoneroWalletRpc {
  private readonly endpoint: string;

  constructor(private readonly options: MoneroWalletRpcOptions) {
    this.endpoint = `${options.url.replace(/\/$/, "")}/json_rpc`;
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.rpcUsername) {
      const basic = Buffer.from(
        `${this.options.rpcUsername}:${this.options.rpcPassword ?? ""}`,
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      throw new MoneroRpcError(
        `monero-wallet-rpc unreachable at ${this.options.url}: ${err.message}`,
      );
    }

    if (!response.ok) {
      throw new MoneroRpcError(
        `monero-wallet-rpc returned HTTP ${response.status} for ${method}`,
      );
    }

    const body = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (body.error) {
      throw new MoneroRpcError(
        `monero-wallet-rpc ${method} failed: ${body.error.message}`,
        body.error.code,
      );
    }
    if (body.result === undefined) {
      throw new MoneroRpcError(`monero-wallet-rpc ${method} returned no result`);
    }
    return body.result;
  }

  /**
   * Open the configured wallet, creating it on first run.
   *
   * A wallet created now has a restore height of the current chain tip, so it
   * syncs in seconds rather than scanning years of blocks. That also means it
   * cannot see funds sent before it existed.
   */
  async openOrCreateWallet(): Promise<{ created: boolean }> {
    try {
      await this.call("open_wallet", {
        filename: this.options.walletName,
        password: this.options.walletPassword,
      });
      return { created: false };
    } catch (err) {
      if (!(err instanceof MoneroRpcError)) throw err;
      logger.info(`Wallet "${this.options.walletName}" not open (${err.message}); creating it`);
    }

    await this.call("create_wallet", {
      filename: this.options.walletName,
      password: this.options.walletPassword,
      language: "English",
    });
    await this.call("open_wallet", {
      filename: this.options.walletName,
      password: this.options.walletPassword,
    });
    return { created: true };
  }

  async getPrimaryAddress(): Promise<string> {
    const result = await this.call<{ address: string }>("get_address", { account_index: 0 });
    return result.address;
  }

  async getBalance(): Promise<MoneroBalance> {
    const result = await this.call<{
      balance: number | string;
      unlocked_balance: number | string;
      blocks_to_unlock?: number;
    }>("get_balance", { account_index: 0 });
    return {
      balancePiconero: BigInt(result.balance),
      unlockedPiconero: BigInt(result.unlocked_balance),
      blocksToUnlock: result.blocks_to_unlock ?? 0,
    };
  }

  async getHeight(): Promise<number> {
    const result = await this.call<{ height: number }>("get_height");
    return result.height;
  }

  /** Scan for new blocks. Cheap against a synced daemon, slow on first run. */
  async refresh(): Promise<void> {
    await this.call("refresh", {});
  }

  /**
   * Create a fresh subaddress.
   *
   * This is what makes an incoming payment attributable. Handing every customer
   * the same address means a payment tells you an amount and nothing else —
   * with one address per job, the address *is* the invoice, and no payment id
   * has to be remembered or supplied correctly by a stranger.
   */
  async createSubaddress(label: string): Promise<Subaddress> {
    const result = await this.call<{ address: string; address_index: number }>(
      "create_address",
      { account_index: 0, label },
    );
    return { address: result.address, index: result.address_index };
  }

  /** Confirmed and pending balance for one subaddress. */
  async getSubaddressBalance(
    index: number,
  ): Promise<{ balancePiconero: bigint; unlockedPiconero: bigint }> {
    const result = await this.call<{
      per_subaddress?: { address_index: number; balance: number | string; unlocked_balance: number | string }[];
    }>("get_balance", { account_index: 0, address_indices: [index] });

    const entry = (result.per_subaddress ?? []).find((e) => e.address_index === index);
    return {
      balancePiconero: entry ? BigInt(entry.balance) : 0n,
      unlockedPiconero: entry ? BigInt(entry.unlocked_balance) : 0n,
    };
  }

  /**
   * Incoming transfers, optionally only those on a given subaddress.
   *
   * Includes pool transactions so a job can be marked paid the moment funds
   * appear, rather than making a customer wait ~20 minutes for confirmations
   * before the work starts. Whether that is acceptable depends on the amount —
   * the caller decides, using the confirmations field.
   */
  async getIncomingTransfers(
    minHeight: number,
    subaddressIndex?: number,
  ): Promise<IncomingTransfer[]> {
    const params: Record<string, unknown> = {
      in: true,
      pool: true,
      filter_by_height: true,
      min_height: minHeight,
      max_height: 4_294_967_295,
      account_index: 0,
    };
    if (subaddressIndex !== undefined) {
      params.subaddr_indices = [subaddressIndex];
    }

    const result = await this.call<{
      in?: any[];
      pool?: any[];
    }>("get_transfers", params);

    return [...(result.in ?? []), ...(result.pool ?? [])].map((t) => ({
      txHash: t.txid,
      amountPiconero: BigInt(t.amount),
      height: t.height ?? 0,
      timestamp: t.timestamp ?? 0,
      subaddressIndex: t.subaddr_index?.minor,
      confirmations: t.confirmations ?? 0,
    }));
  }

  async validateAddress(address: string): Promise<boolean> {
    try {
      const result = await this.call<{ valid: boolean }>("validate_address", {
        address,
        any_net_type: false,
      });
      return result.valid;
    } catch {
      return false;
    }
  }

  /**
   * Send `amountPiconero` to a single destination.
   *
   * Priority 1 ("low") keeps fees small; a donation is never urgent.
   */
  async transfer(params: {
    address: string;
    amountPiconero: bigint;
    priority?: number;
  }): Promise<MoneroTransfer> {
    // The daemon's JSON schema takes amount as a number. Anything above
    // 2^53-1 piconero (~9007 XMR) would lose precision on the way out, so it
    // is refused rather than silently rounded.
    if (params.amountPiconero > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MoneroRpcError(
        `Transfer amount ${formatXmr(params.amountPiconero)} XMR exceeds the ` +
          `precision this client will send in one transaction. Split it.`,
      );
    }

    const result = await this.call<{
      tx_hash: string;
      amount: number | string;
      fee: number | string;
    }>(
      "transfer",
      {
        destinations: [
          {
            address: params.address,
            amount: Number(params.amountPiconero),
          },
        ],
        account_index: 0,
        priority: params.priority ?? 1,
        get_tx_key: true,
      },
      TRANSFER_TIMEOUT_MS,
    );

    return {
      txHash: result.tx_hash,
      amountPiconero: BigInt(result.amount),
      feePiconero: BigInt(result.fee),
    };
  }
}
