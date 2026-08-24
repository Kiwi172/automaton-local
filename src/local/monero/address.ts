/**
 * Monero Address Validation
 *
 * A donation address is the one value in this system that no later check can
 * save you from getting wrong: a typo'd address is either unspendable or
 * someone else's, and Monero transactions do not come back. So addresses are
 * checked properly — base58 decode plus the keccak checksum the address itself
 * carries — rather than by matching a shape with a regex.
 *
 * Monero uses its own base58 variant: fixed 8-byte blocks encoded as 11
 * characters, not Bitcoin's stream encoding, so bs58 cannot read it.
 */

import { keccak256 } from "viem";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FULL_BLOCK_CHARS = 11;
const FULL_BLOCK_BYTES = 8;
/** Encoded length for a decoded block of index+1 bytes. */
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

export type MoneroNetwork = "mainnet" | "stagenet" | "testnet";

/** Address prefixes by network and address kind. */
const PREFIXES: Record<MoneroNetwork, { standard: number; integrated: number; subaddress: number }> = {
  mainnet: { standard: 18, integrated: 19, subaddress: 42 },
  testnet: { standard: 53, integrated: 54, subaddress: 63 },
  stagenet: { standard: 24, integrated: 25, subaddress: 36 },
};

function decodeBlock(chars: string, expectedBytes: number): number[] {
  let value = 0n;
  for (const char of chars) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`Invalid base58 character "${char}"`);
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = new Array(expectedBytes).fill(0);
  for (let i = expectedBytes - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  if (value !== 0n) throw new Error("Base58 block overflows its byte length");
  return bytes;
}

/** Decode a Monero-flavoured base58 string to bytes. */
export function decodeMoneroBase58(input: string): Uint8Array {
  if (input.length === 0) throw new Error("Empty address");

  const fullBlocks = Math.floor(input.length / FULL_BLOCK_CHARS);
  const remainderChars = input.length % FULL_BLOCK_CHARS;
  const remainderBytes = ENCODED_BLOCK_SIZES.indexOf(remainderChars);
  if (remainderBytes < 0) {
    throw new Error(`Invalid base58 length: ${input.length}`);
  }

  const out: number[] = [];
  for (let i = 0; i < fullBlocks; i++) {
    out.push(
      ...decodeBlock(
        input.slice(i * FULL_BLOCK_CHARS, (i + 1) * FULL_BLOCK_CHARS),
        FULL_BLOCK_BYTES,
      ),
    );
  }
  if (remainderChars > 0) {
    out.push(...decodeBlock(input.slice(fullBlocks * FULL_BLOCK_CHARS), remainderBytes));
  }
  return Uint8Array.from(out);
}

export interface MoneroAddressInfo {
  valid: boolean;
  /** Why it failed, for a message a human can act on. */
  reason?: string;
  network?: MoneroNetwork;
  kind?: "standard" | "integrated" | "subaddress";
}

/**
 * Validate a Monero address: decodable, known prefix, intact checksum.
 *
 * @param expectedNetwork When given, an address for a different network is
 *   rejected — sending mainnet funds to a stagenet address is a common and
 *   unrecoverable mistake.
 */
export function validateMoneroAddress(
  address: string,
  expectedNetwork?: MoneroNetwork,
): MoneroAddressInfo {
  const trimmed = address.trim();
  if (!trimmed) return { valid: false, reason: "Address is empty" };

  let decoded: Uint8Array;
  try {
    decoded = decodeMoneroBase58(trimmed);
  } catch (err: any) {
    return { valid: false, reason: `Not a valid Monero base58 string: ${err.message}` };
  }

  if (decoded.length < 5) {
    return { valid: false, reason: "Address is too short to contain a checksum" };
  }

  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const expected = keccak256(payload).slice(2, 10); // first 4 bytes, as hex
  const actual = Buffer.from(checksum).toString("hex");
  if (actual !== expected) {
    return {
      valid: false,
      reason: "Checksum does not match — the address has a typo or was truncated",
    };
  }

  // The prefix is a varint; every prefix in use fits in one byte.
  const prefix = payload[0];
  for (const [network, kinds] of Object.entries(PREFIXES) as [MoneroNetwork, typeof PREFIXES.mainnet][]) {
    for (const [kind, value] of Object.entries(kinds) as ["standard" | "integrated" | "subaddress", number][]) {
      if (value !== prefix) continue;
      if (expectedNetwork && network !== expectedNetwork) {
        return {
          valid: false,
          reason: `This is a ${network} address, but the configured network is ${expectedNetwork}`,
          network,
          kind,
        };
      }
      return { valid: true, network, kind };
    }
  }

  return { valid: false, reason: `Unknown address prefix ${prefix}` };
}
