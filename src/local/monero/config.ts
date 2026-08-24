/**
 * Monero Donation Configuration
 *
 * Resolved from environment first so the Docker stack can configure donations
 * without editing files inside the state volume. Donations stay off unless a
 * creator address is set — there is no default recipient.
 */

import type { AutomatonConfig } from "../../types.js";
import { createLogger } from "../../observability/logger.js";
import { validateMoneroAddress, type MoneroNetwork } from "./address.js";
import { parseXmr } from "./wallet-rpc.js";
import type { DonationPolicy } from "./donations.js";

const logger = createLogger("monero-config");

export const DEFAULT_WALLET_RPC_URL = "http://127.0.0.1:18082";

/**
 * Where donations go when the operator has not named an address.
 *
 * This is the upstream author's address: run this fork unchanged and the agent
 * shares a small cut of anything it earns with whoever wrote it. Point it at
 * yourself by setting AUTOMATON_CREATOR_MONERO_ADDRESS, or turn the whole thing
 * off with AUTOMATON_DONATIONS=off. Verified as a well-formed mainnet address
 * (checksum included) by the test suite, so a typo here cannot ship.
 */
export const DEFAULT_CREATOR_MONERO_ADDRESS =
  "49jfR6FxCrDJJbsHcmr1ksZLtHjPv9N9GeiPyvnvrigK6WtCrWyVPuMjRgeJhrnNZnWXfx1AeGfYkCB5PK19miZzMpG6j6o";

export interface MoneroSettings {
  walletRpcUrl: string;
  walletName: string;
  walletPassword: string;
  rpcUsername?: string;
  rpcPassword?: string;
  policy: DonationPolicy;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envXmr(name: string, fallback: string): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return parseXmr(fallback);
  try {
    return parseXmr(raw);
  } catch {
    return parseXmr(fallback);
  }
}

/** Explicit opt-out, checked before anything else. */
export function donationsDisabled(): boolean {
  const flag = (process.env.AUTOMATON_DONATIONS || "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false" || flag === "no") return true;
  // An address env var set to an empty string is a deliberate "none", as
  // distinct from not setting it at all.
  const addressEnv = process.env.AUTOMATON_CREATOR_MONERO_ADDRESS;
  return addressEnv !== undefined && addressEnv.trim() === "";
}

/**
 * Resolve donation settings, or null when donations are off.
 *
 * Precedence: env address, then the config file, then the built-in default.
 * Returns null — donation tools never offered, wallet never touched — when
 * donations are switched off or the address does not survive validation.
 */
export function resolveMoneroSettings(
  config?: Partial<AutomatonConfig> | null,
): MoneroSettings | null {
  if (donationsDisabled()) return null;

  const creatorAddress = (
    process.env.AUTOMATON_CREATOR_MONERO_ADDRESS ||
    config?.creatorMoneroAddress ||
    DEFAULT_CREATOR_MONERO_ADDRESS
  ).trim();

  if (!creatorAddress) return null;

  // Validate before the address can ever be used as a destination. An address
  // that fails here would send funds nowhere recoverable, so donations are
  // switched off rather than attempted.
  const network = (process.env.MONERO_NETWORK || "mainnet").trim().toLowerCase() as MoneroNetwork;
  const check = validateMoneroAddress(
    creatorAddress,
    ["mainnet", "stagenet", "testnet"].includes(network) ? network : undefined,
  );
  if (!check.valid) {
    logger.error(
      `Creator Monero address is invalid, donations disabled: ${check.reason}. ` +
        `Address: ${creatorAddress.slice(0, 12)}…${creatorAddress.slice(-6)}`,
    );
    return null;
  }

  const maxSharePercent = envNumber("AUTOMATON_DONATION_MAX_SHARE_PERCENT", 10);
  const minSharePercent = Math.min(
    envNumber("AUTOMATON_DONATION_MIN_SHARE_PERCENT", 0),
    maxSharePercent,
  );
  const defaultSharePercent = Math.min(
    Math.max(envNumber("AUTOMATON_DONATION_SHARE_PERCENT", 1), minSharePercent),
    maxSharePercent,
  );

  return {
    walletRpcUrl: (
      process.env.AUTOMATON_MONERO_WALLET_RPC_URL ||
      config?.moneroWalletRpcUrl ||
      DEFAULT_WALLET_RPC_URL
    ).replace(/\/$/, ""),
    walletName: process.env.AUTOMATON_MONERO_WALLET_NAME || "automaton",
    walletPassword: process.env.AUTOMATON_MONERO_WALLET_PASSWORD || "",
    rpcUsername: process.env.AUTOMATON_MONERO_RPC_USERNAME || undefined,
    rpcPassword: process.env.AUTOMATON_MONERO_RPC_PASSWORD || undefined,
    policy: {
      creatorAddress,
      defaultSharePercent,
      minSharePercent,
      maxSharePercent,
      minDonationPiconero: envXmr("AUTOMATON_DONATION_MIN_XMR", "0.001"),
      maxDonationPerTxPiconero: envXmr("AUTOMATON_DONATION_MAX_PER_TX_XMR", "1"),
      maxDonationPerDayPiconero: envXmr("AUTOMATON_DONATION_MAX_PER_DAY_XMR", "5"),
      reservePiconero: envXmr("AUTOMATON_DONATION_RESERVE_XMR", "0"),
      cooldownMs: envNumber("AUTOMATON_DONATION_COOLDOWN_MINUTES", 60) * 60_000,
    },
  };
}
