// Copyright (c) Steelyard contributors. MIT License.
//
// `steelyard` — the SDK front door. A curated re-export of the ~15 symbols 90% of
// developers need, plus the serveCommerce() one-call helper. Everything else is
// still available by importing the specific steelyard/* package directly.
//
//   import { defineCommerce, serveCommerce } from "steelyard";
//
// Power users: for anything not re-exported here, import the underlying package,
// e.g. `steelyard/protocol/ucp`, `steelyard/buyer/vault`, `steelyard/merchant`.

// ── Define ──────────────────────────────────────────────────────────────────
export { defineCommerce } from "@steelyard-dev/core";
export type {
  PaymentMandateIssuer,
  Manifest,
  Offer,
  PaymentMandate,
  PaymentInstrument,
  PaymentInstrumentRecord,
  PaymentMode,
  Price,
  PurchaseIntent
} from "@steelyard-dev/core";

// ── Serve (the one call) ────────────────────────────────────────────────────
export { serveCommerce, createCommerceReadHandler } from "./serve.js";
export type { CommerceProtocol, ServeCommerceOptions } from "./serve.js";

// ── Merchant checkout + PSP adapters ────────────────────────────────────────
export { createCheckoutServer } from "@steelyard-dev/merchant/checkout";
export { stripePsp, referencePsp } from "@steelyard-dev/merchant/psp";

// ── Payment instruments (buyer side) ────────────────────────────────────────
export { stripeSpt } from "@steelyard-dev/stripe/buyer";
export { referenceMandate, vaultedCard } from "@steelyard-dev/buyer";
export { x402Fetch, x402Payments } from "@steelyard-dev/x402";
export { exactUsdc, x402Paywall } from "@steelyard-dev/x402/server";

// ── Buyer: wallet + explore client ──────────────────────────────────────────
export { Wallet } from "@steelyard-dev/buyer";
export { Steelyard, connect } from "@steelyard-dev/buyer/client";

// ── Buyer policy engine types ───────────────────────────────────────────────
export type {
  Intent,
  PolicyDocument,
  Rule,
  CredentialConstraints,
  IssuedCredential,
  PolicyRailAdapter,
  SettlementEvent,
  NormalizedFacts,
  PolicyEngineOptions,
  PolicyDecision,
  PaymentIntentProposal,
  ApprovalStatusResult,
  ApprovalCallbackResult
} from "@steelyard-dev/policy";

export { PolicyEngine, createPolicyEngine } from "@steelyard-dev/policy";
