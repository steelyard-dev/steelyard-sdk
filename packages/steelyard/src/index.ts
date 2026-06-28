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
} from "@steelyard/core";

// ── Serve (the one call) ────────────────────────────────────────────────────
export { serveCommerce, createCommerceReadHandler } from "./serve.js";
export type { CommerceProtocol, ServeCommerceOptions } from "./serve.js";

// ── Merchant checkout + PSP adapters ────────────────────────────────────────
export { createCheckoutServer } from "@steelyard/merchant/checkout";
export { stripePsp, referencePsp } from "@steelyard/merchant/psp";

// ── Payment instruments (buyer side) ────────────────────────────────────────
export { stripeSpt } from "@steelyard/stripe/buyer";
export { referenceMandate, vaultedCard } from "@steelyard/buyer";

// ── Buyer: wallet + explore client ──────────────────────────────────────────
export { Wallet } from "@steelyard/buyer";
export { Steelyard, connect } from "@steelyard/buyer/client";

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
} from "@steelyard/policy";

export { PolicyEngine, createPolicyEngine } from "@steelyard/policy";
