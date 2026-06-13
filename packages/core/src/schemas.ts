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

export const CommerceConfigSchema = z
  .object({
    identity: MerchantIdentitySchema,
    offers: z.array(OfferSchema).default([]),
    policies: PoliciesSchema
  })
  .strict();
export type CommerceConfig = z.input<typeof CommerceConfigSchema>;
export type ParsedCommerceConfig = z.output<typeof CommerceConfigSchema>;
