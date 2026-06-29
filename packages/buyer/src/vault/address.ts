import type { BillingAddress } from "@steelyard-dev/core";

export interface NewAddress {
  id?: string;
  line1: string;
  line2?: string;
  city: string;
  postal_code: string;
  country: string;
  state?: string;
}

export interface StoredAddress extends BillingAddress {
  id: string;
  default: boolean;
}

export function createStoredAddress(
  address: NewAddress,
  id: string,
  opts: { makeDefault: boolean }
): StoredAddress {
  return {
    id: normalizeId(address.id ?? id, "address"),
    line1: required(address.line1, "address line1"),
    line2: optional(address.line2),
    city: required(address.city, "address city"),
    postal_code: required(address.postal_code, "address postal_code"),
    country: normalizeCountry(address.country),
    state: optional(address.state),
    default: opts.makeDefault
  };
}

export function publicAddress(address: StoredAddress): BillingAddress {
  return {
    id: address.id,
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city,
    postal_code: address.postal_code,
    country: address.country,
    ...(address.state ? { state: address.state } : {})
  };
}

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCountry(value: string): string {
  const country = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error("address country must be ISO 3166-1 alpha-2");
  }
  return country;
}

function normalizeId(value: string, kind: string): string {
  const id = value.trim();
  if (!id) throw new Error(`${kind} id is required`);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`${kind} id may only contain letters, numbers, underscores, and hyphens`);
  }
  return id;
}
