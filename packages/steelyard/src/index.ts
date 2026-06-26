// Copyright (c) Steelyard contributors. MIT License.
//
// `steelyard` — the SDK front door. A curated re-export of the ~15 symbols 90% of
// developers need, plus the serveCommerce() one-call helper. Everything else is
// still available by importing the specific @steelyard/* package directly.
//
//   import { defineCommerce, serveCommerce } from "steelyard";
//
// Power users: for anything not re-exported here, import the underlying package,
// e.g. `@steelyard/protocol/ucp`, `@steelyard/buyer/vault`, `@steelyard/merchant`.

// ── Define ──────────────────────────────────────────────────────────────────
export { defineCommerce } from "@steelyard/core";
export type { Manifest, Offer, Price, PurchaseIntent } from "@steelyard/core";

// ── Serve (the one call) ────────────────────────────────────────────────────
export { serveCommerce, createCommerceHandler } from "./serve.js";
export type { CommerceProtocol, ServeCommerceOptions } from "./serve.js";

// ── Expose: per-protocol read surfaces (for custom routing) ─────────────────
export { createMcpServer, createMcpHttpHandler } from "@steelyard/protocol/mcp";
export { createUcpHandler, buildUcpDiscovery } from "@steelyard/protocol/ucp";
export { createAcpFeedHandler, buildAcpFeed } from "@steelyard/protocol/acp";
export { createCommerceManifestHandler } from "@steelyard/protocol/commerce-manifest";
export { createHttpApiHandler } from "@steelyard/protocol/http";

// ── Merchant checkout + PSP adapters ────────────────────────────────────────
export { createMerchantCheckout } from "@steelyard/merchant/checkout";
export { stripePsp, referencePsp } from "@steelyard/merchant/psp";

// ── Payment issuers (buyer side) ────────────────────────────────────────────
export { createStripeSptIssuer } from "@steelyard/stripe/buyer";
export { createReferencePaymentIssuer } from "@steelyard/buyer";

// ── Buyer: wallet + explore client ──────────────────────────────────────────
export { Wallet } from "@steelyard/buyer";
export { Steelyard, connect } from "@steelyard/buyer/client";
