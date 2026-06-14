// Generated from spec/commerce-manifest/0.1/commerce-manifest.schema.json. Do not edit.

export type IsoInstant = string;
export type HttpUrl = string;
export type Currency = string;
export type AttributeValue = string | number | boolean | string[];
export type Price =
  | {
      kind: "one_time";
      amount: number;
      currency: Currency;
      [k: string]: unknown;
    }
  | {
      kind: "recurring";
      amount: number;
      currency: Currency;
      interval: "month" | "year";
      trialDays?: number;
      [k: string]: unknown;
    }
  | {
      kind: "usage_based";
      currency: Currency;
      unit: string;
      unitAmount?: number;
      [k: string]: unknown;
    }
  | {
      kind: "contact_sales";
      [k: string]: unknown;
    };
export type PeerUrl = string;

/**
 * Protocol-agnostic public commerce manifest generated from a Steelyard v0.3 Manifest.
 */
export interface CommerceManifestDoc {
  $schema: "https://steelyard.dev/schemas/commerce-manifest/0.1.json";
  schema_version: "0.1";
  generated_at: IsoInstant;
  identity: MerchantIdentity;
  offers: Offer[];
  policies: Policy[];
  peers: Peers;
  content_hash: string;
  [k: string]: unknown;
}
export interface MerchantIdentity {
  name: string;
  domain?: string;
  description?: string;
  logoUrl?: HttpUrl;
  locale?: string;
  currencies?: Currency[];
  [k: string]: unknown;
}
export interface Offer {
  id: string;
  title: string;
  description?: string;
  images: HttpUrl[];
  url?: HttpUrl;
  kind: "product" | "plan" | "service";
  categories: string[];
  attributes: {
    [k: string]: AttributeValue;
  };
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  pricing: Price[];
  [k: string]: unknown;
}
export interface Policy {
  id: string;
  type: "shipping" | "returns" | "refunds" | "terms" | "privacy" | "other";
  url?: HttpUrl;
  summary?: string;
  [k: string]: unknown;
}
export interface Peers {
  acp?: Peer;
  ucp?: Peer;
  mcp?: Peer;
  http?: Peer;
}
export interface Peer {
  url: PeerUrl;
  protocol_version: string;
  steelyard_read_version?: string;
  [k: string]: unknown;
}

export type CommerceManifestPeer = Peer;
export type PeerName = "acp" | "ucp" | "mcp" | "http";
