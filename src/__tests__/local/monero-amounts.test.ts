/**
 * Amount handling. Monero amounts are integers in piconero; anything that
 * routes them through a float is a bug that costs real money.
 */

import { describe, it, expect } from "vitest";
import { PICONERO_PER_XMR, formatXmr, parseXmr } from "../../local/monero/wallet-rpc.js";

describe("parseXmr", () => {
  it("converts whole and fractional amounts to piconero", () => {
    expect(parseXmr("1")).toBe(PICONERO_PER_XMR);
    expect(parseXmr("0.5")).toBe(PICONERO_PER_XMR / 2n);
    expect(parseXmr("0.000000000001")).toBe(1n);
    expect(parseXmr(2)).toBe(2n * PICONERO_PER_XMR);
  });

  it("is exact for values a double would round", () => {
    // 0.1 + 0.2 !== 0.3 in floating point; here it must be exact.
    expect(parseXmr("0.1") + parseXmr("0.2")).toBe(parseXmr("0.3"));
  });

  it("rejects junk rather than silently producing zero", () => {
    expect(() => parseXmr("abc")).toThrow();
    expect(() => parseXmr("-1")).toThrow();
    expect(() => parseXmr("1e5")).toThrow();
    expect(() => parseXmr("")).toThrow();
  });

  it("rejects more precision than Monero has", () => {
    expect(() => parseXmr("0.0000000000001")).toThrow(/12 decimal/);
  });
});

describe("formatXmr", () => {
  it("renders without trailing zeros", () => {
    expect(formatXmr(PICONERO_PER_XMR)).toBe("1");
    expect(formatXmr(PICONERO_PER_XMR / 2n)).toBe("0.5");
    expect(formatXmr(0n)).toBe("0");
    expect(formatXmr(1n)).toBe("0.000000000001");
  });

  it("round-trips through parseXmr", () => {
    for (const value of ["0.001", "1.5", "1234.567891", "0.000000000001"]) {
      expect(formatXmr(parseXmr(value))).toBe(value);
    }
  });

  it("stays exact for amounts beyond double precision", () => {
    const huge = 9_999_999n * PICONERO_PER_XMR + 123_456_789_012n;
    expect(formatXmr(huge)).toBe("9999999.123456789012");
  });
});
