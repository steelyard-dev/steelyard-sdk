import type { Money } from "./types.js";

const EXPONENTS: Record<string, number> = {
  AUD: 2,
  BHD: 3,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HUF: 0,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  NOK: 2,
  OMR: 3,
  SEK: 2,
  TND: 3,
  USD: 2
};

export function exponent(currency: string): number {
  const value = EXPONENTS[normalizeCurrency(currency)];
  if (value === undefined) throw new Error(`unknown currency: ${currency}`);
  return value;
}

export function fromMajor(value: string, currency: string): bigint {
  const exp = exponent(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`invalid major amount: ${value}`);

  const [, sign = "", intPart = "", fracPart = ""] = match;
  if (fracPart.length > exp) {
    throw new Error(`precision: ${value} exceeds ${exp} decimals for ${normalizeCurrency(currency)}`);
  }

  const padded = `${fracPart}${"0".repeat(exp - fracPart.length)}`;
  const amount = BigInt(`${intPart}${padded}`);
  return sign === "-" ? -amount : amount;
}

export function toMajor(amount_minor: bigint, currency: string): string {
  const exp = exponent(currency);
  if (exp === 0) return amount_minor.toString();

  const sign = amount_minor < 0n ? "-" : "";
  const abs = amount_minor < 0n ? -amount_minor : amount_minor;
  const raw = abs.toString().padStart(exp + 1, "0");
  return `${sign}${raw.slice(0, -exp)}.${raw.slice(-exp)}`;
}

export function addMinor(a: Money, b: Money): Money {
  const currency = normalizeCurrency(a.currency);
  if (currency !== normalizeCurrency(b.currency)) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return { amount_minor: a.amount_minor + b.amount_minor, currency };
}

export function mulRate(amount_minor: bigint, src: string, rate: number, dst: string): Money {
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`invalid FX rate: ${rate}`);
  const srcExp = exponent(src);
  const dstCurrency = normalizeCurrency(dst);
  const dstExp = exponent(dstCurrency);
  const scaled = Number(amount_minor) * rate * 10 ** (dstExp - srcExp);
  if (!Number.isSafeInteger(Math.trunc(scaled))) {
    throw new Error("amount exceeds safe FX conversion range");
  }
  return { amount_minor: bankersRound(scaled), currency: dstCurrency };
}

function normalizeCurrency(currency: string): string {
  return currency.toUpperCase();
}

function bankersRound(value: number): bigint {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return BigInt(floor);
  if (fraction > 0.5) return BigInt(floor + 1);
  return BigInt(floor % 2 === 0 ? floor : floor + 1);
}
