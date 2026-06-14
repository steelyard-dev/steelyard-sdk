import type { CardMetadata } from "@steelyard/core";
import { inspect } from "node:util";
import { domainMatches } from "../policy/glob.js";
import { normalizeMerchantDomain } from "../policy/normalize.js";

export interface NewCard {
  id?: string;
  name_on_card: string;
  pan: string;
  exp: string;
  tags?: string[];
  skipLuhn?: boolean;
}

export interface StoredCard extends CardMetadata {
  pan: string;
}

export type RawCard = CardMetadata & { pan: string };

export function createStoredCard(card: NewCard, id: string): StoredCard {
  const pan = normalizePan(card.pan);
  if (!/^\d{13,19}$/.test(pan)) {
    throw new Error("card pan must be 13-19 digits");
  }
  if (!card.skipLuhn && !luhnValid(pan)) {
    throw new Error("card pan failed Luhn checksum");
  }
  if (card.skipLuhn) {
    process.stderr.write(
      "⚠ steelyard/buyer/vault: addCard called with skipLuhn=true; storing card without Luhn validation.\n"
    );
  }

  const exp = normalizeExp(card.exp);
  const name = card.name_on_card.trim();
  if (!name) throw new Error("card name_on_card is required");

  return {
    id: normalizeId(card.id ?? id, "card"),
    name_on_card: name,
    pan,
    exp,
    brand: detectBrand(pan),
    last4: pan.slice(-4),
    tags: normalizeCardTags(card.tags ?? [])
  };
}

export function cardMetadata(card: StoredCard): CardMetadata {
  return {
    id: card.id,
    name_on_card: card.name_on_card,
    exp: card.exp,
    brand: card.brand,
    last4: card.last4,
    tags: [...card.tags]
  };
}

export function rawCard(card: StoredCard): RawCard {
  const metadata = cardMetadata(card);
  const raw = { ...metadata, pan: card.pan };
  const redacted = () => ({ ...metadata, pan: `****${metadata.last4}` });
  Object.defineProperties(raw, {
    toJSON: { value: redacted, enumerable: false },
    [inspect.custom]: { value: redacted, enumerable: false }
  });
  return raw;
}

export function pickStoredCard(cards: StoredCard[], merchant: string): StoredCard | null {
  const normalizedMerchant = normalizeMerchantDomain(merchant);
  const exact = cards.find((card) => card.tags.some((tag) => tag !== "default" && tag === normalizedMerchant));
  if (exact) return exact;

  const glob = cards.find((card) =>
    card.tags.some((tag) => tag !== "default" && tag.includes("*") && domainMatches(tag, normalizedMerchant))
  );
  if (glob) return glob;

  return cards.find((card) => card.tags.includes("default")) ?? null;
}

function normalizePan(value: string): string {
  return value.replace(/\s+/g, "");
}

function normalizeExp(value: string): string {
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(value.trim());
  if (!match) throw new Error('card exp must be "MM/YY"');
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    throw new Error("card exp is in the past");
  }
  return `${match[1]}/${match[2]}`;
}

function normalizeCardTags(tags: string[]): string[] {
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const value = trimmed.toLowerCase() === "default" ? "default" : normalizeMerchantDomain(trimmed);
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function normalizeId(value: string, kind: string): string {
  const id = value.trim();
  if (!id) throw new Error(`${kind} id is required`);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`${kind} id may only contain letters, numbers, underscores, and hyphens`);
  }
  return id;
}

function detectBrand(pan: string): CardMetadata["brand"] {
  if (/^4/.test(pan)) return "visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(pan)) return "mastercard";
  if (/^3[47]/.test(pan)) return "amex";
  if (/^(6011|65|64[4-9]|622(12[6-9]|1[3-9]\d|[2-8]\d\d|9[01]\d|92[0-5]))/.test(pan)) {
    return "discover";
  }
  return "other";
}

function luhnValid(pan: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = pan.length - 1; index >= 0; index -= 1) {
    let digit = pan.charCodeAt(index) - 48;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}
