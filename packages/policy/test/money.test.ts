import { describe, expect, it } from "vitest";
import { addMinor, exponent, fromMajor, mulRate, toMajor } from "../src/money.js";

describe("money", () => {
  it("knows currency exponents", () => {
    expect(exponent("USD")).toBe(2);
    expect(exponent("JPY")).toBe(0);
    expect(exponent("KWD")).toBe(3);
    expect(exponent("usd")).toBe(2);
  });

  it("rejects unknown currencies", () => {
    expect(() => exponent("XYZ")).toThrow(/unknown currency/);
  });

  it("converts major to minor", () => {
    expect(fromMajor("12.34", "USD")).toBe(1234n);
    expect(fromMajor("1000", "JPY")).toBe(1000n);
    expect(fromMajor("1.234", "KWD")).toBe(1234n);
    expect(fromMajor("-1.25", "USD")).toBe(-125n);
  });

  it("rejects malformed major amounts", () => {
    expect(() => fromMajor("12.3.4", "USD")).toThrow(/invalid major amount/);
  });

  it("rejects too-precise major amounts", () => {
    expect(() => fromMajor("12.345", "USD")).toThrow(/precision/);
  });

  it("converts minor to major", () => {
    expect(toMajor(1234n, "USD")).toBe("12.34");
    expect(toMajor(1000n, "JPY")).toBe("1000");
    expect(toMajor(1234n, "KWD")).toBe("1.234");
    expect(toMajor(5n, "USD")).toBe("0.05");
    expect(toMajor(-5n, "USD")).toBe("-0.05");
  });

  it("adds minor amounts in same currency", () => {
    expect(addMinor({ amount_minor: 100n, currency: "usd" }, { amount_minor: 50n, currency: "USD" })).toEqual({
      amount_minor: 150n,
      currency: "USD"
    });
  });

  it("rejects cross-currency add", () => {
    expect(() => addMinor({ amount_minor: 100n, currency: "USD" }, { amount_minor: 50n, currency: "EUR" })).toThrow(
      /currency mismatch/
    );
  });

  it("applies an FX rate at minor units, rounding half-even", () => {
    expect(mulRate(1234n, "USD", 0.95, "EUR")).toEqual({ amount_minor: 1172n, currency: "EUR" });
    expect(mulRate(101n, "USD", 1.5, "USD")).toEqual({ amount_minor: 152n, currency: "USD" });
    expect(mulRate(103n, "USD", 1.5, "USD")).toEqual({ amount_minor: 154n, currency: "USD" });
    expect(mulRate(101n, "USD", 1.51, "USD")).toEqual({ amount_minor: 153n, currency: "USD" });
  });

  it("rejects invalid FX conversions", () => {
    expect(() => mulRate(100n, "USD", Number.NaN, "EUR")).toThrow(/invalid FX rate/);
    expect(() => mulRate(100n, "USD", -1, "EUR")).toThrow(/invalid FX rate/);
    expect(() => mulRate(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "USD", 2, "EUR")).toThrow(/safe FX conversion/);
  });
});
