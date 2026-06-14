// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { z } from "zod";

export const COMMERCE_READ_VERSION = "0.1" as const;

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const optionalHttpUrl = () =>
  z.preprocess((value) => (isHttpUrl(value) ? value : undefined), z.string().url().optional());

const httpUrlArray = () =>
  z.preprocess(
    (value) => (Array.isArray(value) ? value.filter(isHttpUrl) : value),
    z.array(z.string().url()).default([])
  );

const CurrencySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toUpperCase() : value),
  z.string().regex(/^[A-Z]{3}$/)
);

export const MerchantIdentitySchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1).optional(),
  description: z.string().optional(),
  logoUrl: optionalHttpUrl(),
  locale: z.string().optional(),
  currencies: z.array(CurrencySchema).default([])
});
export type MerchantIdentity = z.infer<typeof MerchantIdentitySchema>;

export const PriceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("one_time"),
    amount: z.number().int().nonnegative(),
    currency: CurrencySchema
  }),
  z.object({
    kind: z.literal("recurring"),
    amount: z.number().int().nonnegative(),
    currency: CurrencySchema,
    interval: z.enum(["month", "year"]),
    trialDays: z.number().int().nonnegative().optional()
  }),
  z.object({
    kind: z.literal("usage_based"),
    currency: CurrencySchema,
    unit: z.string().min(1),
    unitAmount: z.number().int().nonnegative().optional()
  }),
  z.object({ kind: z.literal("contact_sales") })
]);
export type Price = z.infer<typeof PriceSchema>;

export const AttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string())
]);

export const OfferSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  images: httpUrlArray(),
  url: optionalHttpUrl(),
  kind: z.enum(["product", "plan", "service"]).default("product"),
  categories: z.array(z.string()).default([]),
  attributes: z.record(AttributeValueSchema).default({}),
  availability: z.enum(["in_stock", "out_of_stock", "preorder", "unknown"]).default("unknown"),
  pricing: z.array(PriceSchema).default([])
});
export type Offer = z.infer<typeof OfferSchema>;

export const PolicySchema = z.object({
  type: z.enum(["shipping", "returns", "refunds", "terms", "privacy", "other"]),
  url: optionalHttpUrl(),
  summary: z.string().optional()
});
export type Policy = z.infer<typeof PolicySchema>;

export const PoliciesSchema = z.array(PolicySchema).default([]);
export type Policies = z.infer<typeof PoliciesSchema>;

export const ManifestSchema = z.object({
  schemaVersion: z.literal(COMMERCE_READ_VERSION),
  identity: MerchantIdentitySchema,
  catalog: z.object({ offers: z.array(OfferSchema) }),
  policies: PoliciesSchema
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface BillingAddress {
  id?: string;
  line1: string;
  line2?: string;
  city: string;
  postal_code: string;
  country: string;
  state?: string;
}

export interface SimpleCard {
  number: string;
  exp: string;
  name: string;
}

export interface SimpleLimits {
  [currency: string]: number | undefined;
}

export interface ApprovalProof {
  source: "user" | "out-of-band" | string;
  signature?: string;
  ts: string;
}

export interface CardMetadata {
  id: string;
  name_on_card: string;
  exp: string;
  brand: "visa" | "mastercard" | "amex" | "discover" | "other";
  last4: string;
  tags: string[];
}

export interface BillingPayload {
  name: string;
  email?: string;
  address: BillingAddress;
}

export interface SpendReceipt {
  ts: string;
  intent_id: string;
  merchant_domain: string;
  amount: number;
  currency: string;
  status: "completed" | "failed";
  rule?: string;
}

export interface SpendLimits {
  daily?: Record<string, number>;
  weekly?: Record<string, number>;
  monthly?: Record<string, number>;
}

export interface Rule {
  name: string;
  effect: "can" | "cannot";
  action: "buy";
  where?: {
    merchant_domain?: string | string[];
    currency?: string | string[];
    amount?: {
      lte?: number;
      gte?: number;
      between?: [number, number];
    };
    offer_category?: string | string[];
  };
  requires_approval_above?: {
    amount: number;
    currency: string;
  };
}

export type Decision =
  | { status: "allowed"; rule: string }
  | { status: "denied"; reason: string }
  | {
      status: "approval_required";
      threshold: { amount: number; currency: string };
      matched_rule: string;
    };

export interface PurchaseIntent {
  merchant: {
    domain: string;
    declared_domain?: string;
    transport_url: string;
    protocol: "mcp" | "acp" | "ucp";
  };
  offer: { id: string; title: string; categories: string[] };
  amount: number;
  currency: string;
  intent_id?: string;
}

export const CommerceConfigSchema = z
  .object({
    identity: MerchantIdentitySchema,
    offers: z.array(OfferSchema).default([]),
    policies: PoliciesSchema
  })
  .strict();
export type CommerceConfig = z.input<typeof CommerceConfigSchema>;
export type ParsedCommerceConfig = z.output<typeof CommerceConfigSchema>;
