/**
 * Donation configuration: the built-in default recipient, the opt-out, and the
 * address validation that stands between a typo and unrecoverable funds.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_CREATOR_MONERO_ADDRESS,
  donationsDisabled,
  resolveMoneroSettings,
} from "../../local/monero/config.js";
import { validateMoneroAddress, decodeMoneroBase58 } from "../../local/monero/address.js";

const KEYS = [
  "AUTOMATON_DONATIONS",
  "AUTOMATON_CREATOR_MONERO_ADDRESS",
  "AUTOMATON_MONERO_WALLET_RPC_URL",
  "AUTOMATON_DONATION_SHARE_PERCENT",
  "AUTOMATON_DONATION_MIN_SHARE_PERCENT",
  "AUTOMATON_DONATION_MAX_SHARE_PERCENT",
  "AUTOMATON_DONATION_MAX_PER_TX_XMR",
  "MONERO_NETWORK",
];

// A different, independently valid mainnet address.
const OTHER_ADDRESS =
  "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the built-in default address", () => {
  it("is a valid mainnet address, checksum included", () => {
    // If this ever fails, the default recipient is unreachable and every
    // donation made with default settings would be lost.
    const result = validateMoneroAddress(DEFAULT_CREATOR_MONERO_ADDRESS, "mainnet");
    expect(result).toMatchObject({ valid: true, network: "mainnet", kind: "standard" });
  });

  it("is used when nothing else is configured", () => {
    const settings = resolveMoneroSettings(null);
    expect(settings?.policy.creatorAddress).toBe(DEFAULT_CREATOR_MONERO_ADDRESS);
  });

  it("gives way to an address in the config file", () => {
    const settings = resolveMoneroSettings({ creatorMoneroAddress: OTHER_ADDRESS } as any);
    expect(settings?.policy.creatorAddress).toBe(OTHER_ADDRESS);
  });

  it("gives way to an address in the environment", () => {
    process.env.AUTOMATON_CREATOR_MONERO_ADDRESS = OTHER_ADDRESS;
    const settings = resolveMoneroSettings({ creatorMoneroAddress: DEFAULT_CREATOR_MONERO_ADDRESS } as any);
    expect(settings?.policy.creatorAddress).toBe(OTHER_ADDRESS);
  });
});

describe("turning donations off", () => {
  it("respects AUTOMATON_DONATIONS=off and friends", () => {
    for (const value of ["off", "OFF", "0", "false", "no"]) {
      process.env.AUTOMATON_DONATIONS = value;
      expect(donationsDisabled()).toBe(true);
      expect(resolveMoneroSettings(null)).toBeNull();
    }
  });

  it("treats an explicitly empty address as 'none'", () => {
    process.env.AUTOMATON_CREATOR_MONERO_ADDRESS = "";
    expect(donationsDisabled()).toBe(true);
    expect(resolveMoneroSettings(null)).toBeNull();
  });

  it("stays on when the variables are simply absent", () => {
    expect(donationsDisabled()).toBe(false);
    expect(resolveMoneroSettings(null)).not.toBeNull();
  });
});

describe("refusing bad addresses", () => {
  it("disables donations rather than sending to a typo'd address", () => {
    const typo = DEFAULT_CREATOR_MONERO_ADDRESS.slice(0, 40) + "X" + DEFAULT_CREATOR_MONERO_ADDRESS.slice(41);
    process.env.AUTOMATON_CREATOR_MONERO_ADDRESS = typo;
    expect(resolveMoneroSettings(null)).toBeNull();
  });

  it("rejects an address for the wrong network", () => {
    process.env.MONERO_NETWORK = "stagenet";
    process.env.AUTOMATON_CREATOR_MONERO_ADDRESS = OTHER_ADDRESS; // mainnet
    expect(resolveMoneroSettings(null)).toBeNull();
  });

  it("rejects an Ethereum address pasted in by mistake", () => {
    process.env.AUTOMATON_CREATOR_MONERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    expect(resolveMoneroSettings(null)).toBeNull();
  });
});

describe("policy bounds", () => {
  it("keeps the default share inside the operator's min/max", () => {
    process.env.AUTOMATON_DONATION_SHARE_PERCENT = "50";
    process.env.AUTOMATON_DONATION_MAX_SHARE_PERCENT = "10";
    expect(resolveMoneroSettings(null)!.policy.defaultSharePercent).toBe(10);
  });

  it("never lets the floor exceed the ceiling", () => {
    process.env.AUTOMATON_DONATION_MIN_SHARE_PERCENT = "80";
    process.env.AUTOMATON_DONATION_MAX_SHARE_PERCENT = "5";
    const policy = resolveMoneroSettings(null)!.policy;
    expect(policy.minSharePercent).toBeLessThanOrEqual(policy.maxSharePercent);
  });

  it("falls back to the default limit when given a nonsense amount", () => {
    process.env.AUTOMATON_DONATION_MAX_PER_TX_XMR = "banana";
    expect(resolveMoneroSettings(null)!.policy.maxDonationPerTxPiconero).toBeGreaterThan(0n);
  });
});

describe("address decoding", () => {
  it("decodes Monero's block base58, which is not Bitcoin's", () => {
    // 95 characters = 8 full blocks (11 chars each) + a 7-char tail = 69 bytes:
    // 1 prefix + 32 spend + 32 view + 4 checksum.
    expect(decodeMoneroBase58(DEFAULT_CREATOR_MONERO_ADDRESS)).toHaveLength(69);
  });

  it("rejects characters outside the alphabet", () => {
    expect(validateMoneroAddress("4" + "0".repeat(94)).valid).toBe(false);
  });

  it("rejects a truncated address", () => {
    expect(validateMoneroAddress(DEFAULT_CREATOR_MONERO_ADDRESS.slice(0, 60)).valid).toBe(false);
  });
});
