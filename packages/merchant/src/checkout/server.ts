// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  canonicalMerchantAudience,
  systemClock,
  totalAmount,
  type Manifest,
  type Offer,
  type PurchaseIntent,
  type Total
} from "@steelyard/core";
import {
  applyCancelRequest,
  applyCompleteRequest,
  applyCreateRequest,
  applyDiscountsRequest,
  applyUpdateRequest,
  type CheckoutSession
} from "@steelyard/protocol/acp/checkout";
import {
  applyUcpCancel,
  applyUcpComplete,
  applyUcpCreate,
  applyUcpUpdate,
  assertValidUcpCheckout,
  type Checkout as UcpCheckout,
  type SelectedPaymentInstrument
} from "@steelyard/protocol/ucp/checkout";
import type { MandateVerificationResult, MandateVerifier } from "../mandate/index.js";
import type { MerchantPolicy } from "../policy/index.js";
import type { PspAdapter, PspCaptureResult } from "../psp/index.js";
import { IdempotencyConflict, type IdempotencyResponse, type IdempotencyStore } from "./idempotency.js";
import {
  StoreCasConflict,
  StoreNotFound,
  type CheckoutSessionStore,
  type StoredCheckout
} from "./store.js";

export interface MerchantCheckoutOpts {
  protocols: ("acp" | "ucp")[];
  store: CheckoutSessionStore;
  psp: PspAdapter;
  policy?: MerchantPolicy;
  mandateVerifier?: MandateVerifier;
  steelyardMandate?: boolean;
  idempotency: IdempotencyStore;
  clock?: () => Date;
  merchantAudience?: string;
  baseUrl?: string;
}

export interface AcpRoutes {
  createSession(req: IncomingMessage, res: ServerResponse): Promise<void>;
  getSession(req: IncomingMessage, res: ServerResponse): Promise<void>;
  updateSession(req: IncomingMessage, res: ServerResponse): Promise<void>;
  completeSession(req: IncomingMessage, res: ServerResponse): Promise<void>;
  cancelSession(req: IncomingMessage, res: ServerResponse): Promise<void>;
  discounts(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface UcpRoutes {
  createCheckout(req: IncomingMessage, res: ServerResponse): Promise<void>;
  getCheckout(req: IncomingMessage, res: ServerResponse): Promise<void>;
  updateCheckout(req: IncomingMessage, res: ServerResponse): Promise<void>;
  completeCheckout(req: IncomingMessage, res: ServerResponse): Promise<void>;
  cancelCheckout(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface MerchantCheckout {
  handler: RequestListener;
  store: CheckoutSessionStore;
  routes: {
    acp?: AcpRoutes;
    ucp?: UcpRoutes;
  };
}

export class MerchantCheckoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MerchantCheckoutConfigError";
  }
}

export function createMerchantCheckout(manifest: Manifest, opts: MerchantCheckoutOpts): MerchantCheckout {
  const protocols = new Set(opts.protocols);
  if (!protocols.has("acp") && !protocols.has("ucp")) {
    throw new MerchantCheckoutConfigError("createMerchantCheckout requires at least one protocol");
  }
  if (protocols.has("ucp") && opts.steelyardMandate && !opts.mandateVerifier) {
    throw new MerchantCheckoutConfigError("mandateVerifier is required when steelyardMandate is enabled");
  }
  assertPspCurrencySupport(manifest, opts.psp);

  const ctx = new MerchantCheckoutContext(manifest, opts);
  const routes = {
    ...(protocols.has("acp") ? { acp: createAcpRoutes(ctx) } : {}),
    ...(protocols.has("ucp") ? { ucp: createUcpRoutes(ctx) } : {})
  };

  const handler: RequestListener = (req, res) => {
    void dispatch(req, res, routes).catch((error) => sendMappedError(res, error));
  };
  return { handler, store: opts.store, routes };
}

class MerchantCheckoutContext {
  readonly clock: () => Date;
  readonly ucpAudience: string;

  constructor(
    readonly manifest: Manifest,
    readonly opts: MerchantCheckoutOpts
  ) {
    this.clock = opts.clock ?? systemClock;
    this.ucpAudience =
      opts.merchantAudience ??
      canonicalMerchantAudience({
        id: manifest.identity.domain ?? manifest.identity.name,
        protocol: "ucp",
        origin: opts.baseUrl ?? manifest.identity.domain ?? "localhost"
      });
  }

  async evaluatePolicy(protocol: "acp" | "ucp", source: unknown): Promise<IdempotencyResponse | undefined> {
    if (!this.opts.policy) return undefined;
    const intent = purchaseIntentFromSource(this.manifest, protocol, source);
    const decision = await this.opts.policy.evaluate(intent);
    if (decision.status === "denied") {
      return { status: 403, body: { error: "policy_denied", reason: decision.reason } };
    }
    if (decision.status === "approval_required") {
      return { status: 409, body: { error: "approval_required", threshold: decision.threshold } };
    }
    return undefined;
  }
}

function createAcpRoutes(ctx: MerchantCheckoutContext): AcpRoutes {
  return {
    async createSession(req, res) {
      await withJsonIdempotency(ctx, req, res, "acp:create", async (body) => {
        const policy = await ctx.evaluatePolicy("acp", body);
        if (policy) return policy;
        const now = ctx.clock();
        const result = applyCreateRequest(body as Record<string, unknown>, {
          manifest: ctx.manifest,
          now,
          sessionId: `cs_${randomUUID()}`
        });
        await ctx.opts.store.put(withAcpPaymentHandlers(result.next, ctx.opts.psp) as StoredCheckout);
        return { status: 200, body: withAcpPaymentHandlers(result.response, ctx.opts.psp) };
      });
    },
    async getSession(req, res) {
      const id = pathId(req, "/acp/checkout_sessions/");
      const session = await requireSession(ctx.opts.store, id);
      sendJson(res, 200, session);
    },
    async updateSession(req, res) {
      const id = pathId(req, "/acp/checkout_sessions/");
      await withJsonIdempotency(ctx, req, res, `acp:update:${id}`, async (body) => {
        const current = await requireSession(ctx.opts.store, id);
        const policy = await ctx.evaluatePolicy("acp", body);
        if (policy) return policy;
        const result = applyUpdateRequest(current as CheckoutSession, body as Record<string, unknown>, {
          now: ctx.clock()
        });
        await ctx.opts.store.put(result.next as StoredCheckout);
        return { status: 200, body: result.response };
      });
    },
    async completeSession(req, res) {
      const id = pathId(req, "/acp/checkout_sessions/", "/complete");
      await withJsonIdempotency(ctx, req, res, `acp:complete:${id}`, async (body, idempotencyKey) => {
        const current = await requireSession(ctx.opts.store, id);
        const policy = await ctx.evaluatePolicy("acp", current);
        if (policy) return policy;
        let status = 200;
        const next = await ctx.opts.store.transition(id, "ready_for_payment", "complete_in_progress", async (claimed) => {
          const payment = acpPaymentData(body);
          if (!ctx.opts.psp.supportsHandler(payment.handler_id)) {
            status = 400;
            return {
              next: checkoutCanceled(
                claimed,
                "payment_handler_mismatch",
                "PSP does not support the selected handler",
                ctx.clock()
              )
            };
          }
          const pspResult = await capture(ctx, "acp", claimed, payment, idempotencyKey);
          if (!pspResult.ok) {
            status = 402;
            return {
              next: checkoutCanceled(claimed, pspFailureCode(pspResult), pspFailureMessage(pspResult), ctx.clock())
            };
          }
          const completed = applyCompleteRequest(claimed as CheckoutSession, body as Record<string, unknown>, {
            now: ctx.clock(),
            pspResult
          });
          return { next: completed.next as StoredCheckout };
        });
        return { status, body: next };
      });
    },
    async cancelSession(req, res) {
      const id = pathId(req, "/acp/checkout_sessions/", "/cancel");
      await withJsonIdempotency(ctx, req, res, `acp:cancel:${id}`, async (body) => {
        const current = await requireSession(ctx.opts.store, id);
        const next = await ctx.opts.store.transition(id, current.status, "canceled", async (claimed) => {
          const canceled = applyCancelRequest(claimed as CheckoutSession, body as Record<string, unknown>, {
            now: ctx.clock()
          });
          return { next: canceled.next as StoredCheckout };
        });
        return { status: 200, body: next };
      });
    },
    async discounts(req, res) {
      const body = await readJsonBody(req);
      sendJson(res, 200, applyDiscountsRequest(ctx.manifest, body as { codes?: string[] }));
    }
  };
}

function createUcpRoutes(ctx: MerchantCheckoutContext): UcpRoutes {
  const mandateVerifier = ctx.opts.mandateVerifier;
  if (ctx.opts.steelyardMandate && !mandateVerifier) {
    throw new MerchantCheckoutConfigError("mandateVerifier is required when steelyardMandate is enabled");
  }

  return {
    async createCheckout(req, res) {
      await withJsonIdempotency(ctx, req, res, "ucp:create", async (body) => {
        const policy = await ctx.evaluatePolicy("ucp", body);
        if (policy) return policy;
        const result = applyUcpCreate(body as Partial<UcpCheckout>, {
          now: ctx.clock(),
          checkoutId: `checkout_${randomUUID()}`,
          currency: checkoutCurrency(ctx.manifest),
          links: []
        });
        const next = withUcpPaymentHandlers(withUcpCatalogDetails(ctx.manifest, result.next), ctx.opts.psp);
        await ctx.opts.store.put(next as StoredCheckout);
        return { status: 200, body: next };
      });
    },
    async getCheckout(req, res) {
      const id = pathId(req, "/ucp/api/checkout/");
      sendJson(res, 200, await requireSession(ctx.opts.store, id));
    },
    async updateCheckout(req, res) {
      const id = pathId(req, "/ucp/api/checkout/");
      await withJsonIdempotency(ctx, req, res, `ucp:update:${id}`, async (body) => {
        const current = await requireSession(ctx.opts.store, id);
        const policy = await ctx.evaluatePolicy("ucp", body);
        if (policy) return policy;
        const result = applyUcpUpdate(current as UcpCheckout, body as Partial<UcpCheckout>, { now: ctx.clock() });
        const next = withUcpCatalogDetails(ctx.manifest, result.next);
        await ctx.opts.store.put(next as StoredCheckout);
        return { status: 200, body: next };
      });
    },
    async completeCheckout(req, res) {
      const id = pathId(req, "/ucp/api/checkout/", "/complete");
      await withJsonIdempotency(ctx, req, res, `ucp:complete:${id}`, async (body, idempotencyKey) => {
        const current = await requireSession(ctx.opts.store, id);
        const policy = await ctx.evaluatePolicy("ucp", current);
        if (policy) return policy;
        let status = 200;
        const next = await ctx.opts.store.transition(id, "ready_for_complete", "complete_in_progress", async (claimed) => {
          const payment = ucpPaymentData(body);
          if (!ctx.opts.psp.supportsHandler(payment.handler_id)) {
            status = 400;
            return {
              next: checkoutCanceled(
                claimed,
                "payment_handler_mismatch",
                "PSP does not support the selected handler",
                ctx.clock()
              )
            };
          }
          let mandateOk: Extract<MandateVerificationResult, { ok: true }> | undefined;
          if (ctx.opts.steelyardMandate) {
            const mandate = await mandateVerifier!.verify(
              body as Record<string, unknown>,
              { ...claimed, payment: (body as Record<string, unknown>).payment },
              ctx.ucpAudience
            );
            if (!mandate.ok) {
              status = 400;
              return {
                next: checkoutCanceled(
                  claimed,
                  mandateErrorCode(mandate.reason),
                  mandate.reason,
                  ctx.clock()
                )
              };
            }
            mandateOk = mandate;
          }
          const pspResult = await capture(ctx, "ucp", claimed, payment, idempotencyKey);
          if (!pspResult.ok) {
            status = 402;
            return {
              next: checkoutCanceled(claimed, pspFailureCode(pspResult), pspFailureMessage(pspResult), ctx.clock())
            };
          }
          const completed = applyUcpComplete(claimed as UcpCheckout, body as { payment: { instruments: SelectedPaymentInstrument[] } }, {
            now: ctx.clock(),
            mandateOk,
            pspResult,
            orderId: `order_${id}`,
            permalinkUrl: `https://example.com/orders/${encodeURIComponent(id)}`
          });
          return { next: withPspReference(completed.next, pspResult) as StoredCheckout };
        });
        return { status, body: next };
      });
    },
    async cancelCheckout(req, res) {
      const id = pathId(req, "/ucp/api/checkout/", "/cancel");
      await withJsonIdempotency(ctx, req, res, `ucp:cancel:${id}`, async () => {
        const current = await requireSession(ctx.opts.store, id);
        const next = await ctx.opts.store.transition(id, current.status, "canceled", async (claimed) => {
          const canceled = applyUcpCancel(claimed as UcpCheckout, { now: ctx.clock() });
          return { next: canceled.next as StoredCheckout };
        });
        return { status: 200, body: next };
      });
    }
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: { acp?: AcpRoutes; ucp?: UcpRoutes }
): Promise<void> {
  const path = requestPath(req);
  if (routes.acp) {
    if (req.method === "POST" && path === "/acp/checkout_sessions") return await routes.acp.createSession(req, res);
    if (req.method === "GET" && /^\/acp\/checkout_sessions\/[^/]+$/.test(path)) {
      return await routes.acp.getSession(req, res);
    }
    if (req.method === "PATCH" && /^\/acp\/checkout_sessions\/[^/]+$/.test(path)) {
      return await routes.acp.updateSession(req, res);
    }
    if (req.method === "POST" && /^\/acp\/checkout_sessions\/[^/]+\/complete$/.test(path)) {
      return await routes.acp.completeSession(req, res);
    }
    if (req.method === "POST" && /^\/acp\/checkout_sessions\/[^/]+\/cancel$/.test(path)) {
      return await routes.acp.cancelSession(req, res);
    }
    if (req.method === "POST" && path === "/acp/discounts") return await routes.acp.discounts(req, res);
  }

  if (routes.ucp) {
    if (req.method === "POST" && path === "/ucp/api/checkout") return await routes.ucp.createCheckout(req, res);
    if (req.method === "GET" && /^\/ucp\/api\/checkout\/[^/]+$/.test(path)) return await routes.ucp.getCheckout(req, res);
    if (req.method === "PATCH" && /^\/ucp\/api\/checkout\/[^/]+$/.test(path)) {
      return await routes.ucp.updateCheckout(req, res);
    }
    if (req.method === "POST" && /^\/ucp\/api\/checkout\/[^/]+\/complete$/.test(path)) {
      return await routes.ucp.completeCheckout(req, res);
    }
    if (req.method === "POST" && /^\/ucp\/api\/checkout\/[^/]+\/cancel$/.test(path)) {
      return await routes.ucp.cancelCheckout(req, res);
    }
  }

  sendJson(res, 404, { error: "not_found" });
}

async function withJsonIdempotency(
  ctx: MerchantCheckoutContext,
  req: IncomingMessage,
  res: ServerResponse,
  scope: string,
  fn: (body: unknown, idempotencyKey: string) => Promise<IdempotencyResponse>
): Promise<void> {
  const body = await readJsonBody(req);
  const key = idempotencyKey(req);
  if (!key) {
    sendJson(res, 400, { error: "idempotency_key_required" });
    return;
  }
  const response = await ctx.opts.idempotency.remember(key, bodyHash(scope, body), () => fn(body, key));
  sendJson(res, response.status, response.body);
}

async function capture(
  ctx: MerchantCheckoutContext,
  protocol: "acp" | "ucp",
  session: StoredCheckout,
  payment: { vault_token: string; handler_id: string },
  _httpIdempotencyKey: string
): Promise<PspCaptureResult> {
  const id = session.id;
  return await ctx.opts.psp.capture({
    vault_token: payment.vault_token,
    amount: totalAmount(totals(session)),
    currency: stringValue(session.currency, checkoutCurrency(ctx.manifest)),
    metadata: { protocol, checkout_id: id },
    idempotencyKey: `psp:${protocol}:${id}:capture`,
    session_id: id,
    merchant_id: ctx.manifest.identity.domain ?? ctx.manifest.identity.name,
    handler_id: payment.handler_id
  });
}

async function requireSession(store: CheckoutSessionStore, id: string): Promise<StoredCheckout> {
  const session = await store.get(id);
  if (!session) throw new StoreNotFound(id);
  return session;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function acpPaymentData(body: unknown): { vault_token: string; handler_id: string } {
  const paymentData = asRecord(asRecord(body).payment_data);
  const instrument = asRecord(paymentData.instrument);
  const credential = asRecord(instrument.credential);
  const token = stringValue(credential.token, "");
  const handlerId = stringValue(paymentData.handler_id, "");
  if (!token) throw new HttpError(400, "vault_token_required");
  if (!handlerId) throw new HttpError(400, "payment_handler_required");
  return { vault_token: token, handler_id: handlerId };
}

function mandateErrorCode(reason: string): string {
  if (reason === "audience_mismatch") return "mandate_audience_mismatch";
  if (reason === "missing_mandate") return "mandate_required";
  return "mandate_invalid";
}

function ucpPaymentData(body: unknown): { vault_token: string; handler_id: string } {
  const payment = asRecord(asRecord(body).payment);
  const instruments = payment.instruments;
  if (!Array.isArray(instruments)) throw new HttpError(400, "payment_instrument_required");
  const selected = instruments.map(asRecord).find((instrument) => instrument.selected === true) ?? asRecord(instruments[0]);
  const credential = asRecord(selected.credential);
  const token = stringValue(credential.token, "");
  const handlerId = stringValue(selected.handler_id, "");
  if (!token) throw new HttpError(400, "vault_token_required");
  if (!handlerId) throw new HttpError(400, "payment_handler_required");
  return { vault_token: token, handler_id: handlerId };
}

function withAcpPaymentHandlers(session: Record<string, unknown>, psp: PspAdapter): Record<string, unknown> {
  return {
    ...session,
    capabilities: {
      ...asRecord(session.capabilities),
      payment: {
        handlers: [
          {
            id: psp.name,
            name: "dev.steelyard.vault_token",
            display_name: "Vault token",
            version: "2026-04-17",
            spec: "https://steelyard.dev/specs/payment/vault-token",
            requires_delegate_payment: true,
            requires_pci_compliance: false,
            psp: psp.name,
            config_schema: "https://steelyard.dev/schemas/payment-handler-config.json",
            instrument_schemas: ["https://steelyard.dev/schemas/vault-token-instrument.json"],
            config: {}
          }
        ]
      }
    }
  };
}

function withUcpPaymentHandlers(checkout: Record<string, unknown>, psp: PspAdapter): Record<string, unknown> {
  return {
    ...checkout,
    ucp: {
      ...asRecord(checkout.ucp),
      payment_handlers: {
        "net.steelyard": [
          {
            id: psp.name,
            version: "2026-04-17",
            spec: "https://steelyard.dev/specs/payment/vault-token",
            schema: "https://ucp.dev/schemas/payment_handler.json",
            config: { token_type: "vault_token" }
          }
        ]
      }
    }
  };
}

function withUcpCatalogDetails(manifest: Manifest, checkout: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(checkout.line_items)) return checkout;
  let checkoutTotal = 0;
  const lineItems = checkout.line_items.map((value, index) => {
    const line = asRecord(value);
    const item = asRecord(line.item);
    const id = stringValue(item.id, `item_${index + 1}`);
    const offer = manifest.catalog.offers.find((candidate) => candidate.id === id);
    const quantity = integerValue(line.quantity, 1);
    const unitAmount = firstPriceAmount(offer) ?? integerValue(item.price, 0);
    const lineTotal = unitAmount * quantity;
    checkoutTotal += lineTotal;
    return {
      ...line,
      id: stringValue(line.id, `line_${index + 1}`),
      item: {
        ...item,
        id,
        title: offer?.title ?? stringValue(item.title, id),
        price: unitAmount
      },
      quantity,
      totals: [{ type: "total", display_text: "Total", amount: lineTotal }]
    };
  });
  const next = {
    ...checkout,
    line_items: lineItems,
    totals: [
      { type: "subtotal", display_text: "Subtotal", amount: checkoutTotal },
      { type: "total", display_text: "Total", amount: checkoutTotal }
    ]
  };
  assertValidUcpCheckout(next);
  return next;
}

function withPspReference(session: Record<string, unknown>, pspResult: PspCaptureResult): Record<string, unknown> {
  if (!pspResult.ok) return session;
  return {
    ...session,
    payment_details: {
      ...asRecord(session.payment_details),
      psp_payment_id: pspResult.psp_payment_id,
      psp_status: pspResult.status
    }
  };
}

function checkoutCanceled(session: StoredCheckout, code: string, message: string, now: Date): StoredCheckout {
  return {
    ...session,
    status: "canceled",
    updated_at: now.toISOString(),
    messages: {
      errors: [{ code, message }]
    }
  };
}

function pspFailureCode(result: PspCaptureResult): string {
  if (result.ok) return "payment_failed";
  if ("requires_authentication" in result) return "payment_authentication_required";
  return `payment_${result.reason}`;
}

function pspFailureMessage(result: PspCaptureResult): string {
  if (result.ok) return "payment failed";
  if ("requires_authentication" in result) return result.continue_url;
  return result.message;
}

function purchaseIntentFromSource(manifest: Manifest, protocol: "acp" | "ucp", source: unknown): PurchaseIntent {
  const offer = firstOffer(manifest, source);
  const currency = currencyFromSource(source) ?? firstPriceCurrency(offer) ?? checkoutCurrency(manifest);
  return {
    merchant: {
      domain: manifest.identity.domain ?? manifest.identity.name,
      transport_url: "",
      protocol
    },
    offer: {
      id: offer?.id ?? "checkout",
      title: offer?.title ?? "Checkout",
      categories: offer?.categories ?? []
    },
    amount: amountFromSource(source) ?? firstPriceAmount(offer) ?? 0,
    currency
  };
}

function firstOffer(manifest: Manifest, source: unknown): Offer | undefined {
  const ids = lineItemOfferIds(source);
  return ids.map((id) => manifest.catalog.offers.find((offer) => offer.id === id)).find((offer) => !!offer);
}

function lineItemOfferIds(source: unknown): string[] {
  const items = asRecord(source).line_items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const record = asRecord(item);
      return stringValue(record.id, "") || stringValue(asRecord(record.item).id, "");
    })
    .filter(Boolean);
}

function amountFromSource(source: unknown): number | undefined {
  const record = asRecord(source);
  if (Array.isArray(record.totals)) {
    try {
      return totalAmount(record.totals as Total[]);
    } catch {
      return undefined;
    }
  }
  const items = record.line_items;
  if (!Array.isArray(items)) return undefined;
  const total = items.reduce((sum, item) => sum + lineItemAmount(item), 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function lineItemAmount(item: unknown): number {
  const record = asRecord(item);
  if (Array.isArray(record.totals)) {
    try {
      return totalAmount(record.totals as Total[]);
    } catch {
      return 0;
    }
  }
  const quantity = integerValue(record.quantity, 1);
  const nested = asRecord(record.item);
  return integerValue(record.unit_amount, integerValue(nested.price, 0)) * quantity;
}

function currencyFromSource(source: unknown): string | undefined {
  const currency = asRecord(source).currency;
  return typeof currency === "string" && currency ? currency.toUpperCase() : undefined;
}

function checkoutCurrency(manifest: Manifest): string {
  return manifest.identity.currencies[0] ?? offerCurrencies(manifest)[0] ?? "USD";
}

function firstPriceAmount(offer: Offer | undefined): number | undefined {
  const price = offer?.pricing.find((row) => "amount" in row && typeof row.amount === "number");
  return price && "amount" in price ? price.amount : undefined;
}

function firstPriceCurrency(offer: Offer | undefined): string | undefined {
  const price = offer?.pricing.find((row) => "currency" in row && typeof row.currency === "string");
  return price && "currency" in price ? price.currency : undefined;
}

function assertPspCurrencySupport(manifest: Manifest, psp: PspAdapter): void {
  const supported = (psp as PspAdapter & { supportedCurrencies?: readonly string[] }).supportedCurrencies;
  if (!supported) return;
  const supportedSet = new Set(supported.map((currency) => currency.toUpperCase()));
  const unsupported = offerCurrencies(manifest).filter((currency) => !supportedSet.has(currency));
  if (unsupported.length) {
    throw new MerchantCheckoutConfigError(`PSP ${psp.name} does not support currencies: ${unsupported.join(", ")}`);
  }
}

function offerCurrencies(manifest: Manifest): string[] {
  const currencies = new Set<string>(manifest.identity.currencies);
  for (const offer of manifest.catalog.offers) {
    for (const price of offer.pricing) {
      if ("currency" in price) currencies.add(price.currency);
    }
  }
  return [...currencies];
}

function bodyHash(scope: string, body: unknown): string {
  return createHash("sha256").update(`${scope}\n${stableJson(body)}`).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const value = req.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
}

function pathId(req: IncomingMessage, prefix: string, suffix = ""): string {
  const path = requestPath(req);
  const withoutPrefix = path.slice(prefix.length);
  const raw = suffix ? withoutPrefix.slice(0, -suffix.length) : withoutPrefix;
  return decodeURIComponent(raw.replace(/^\/+|\/+$/g, ""));
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function totals(session: StoredCheckout): Total[] {
  return Array.isArray(session.totals) ? (session.totals as Total[]) : [];
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sendMappedError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code });
    return;
  }
  if (error instanceof StoreCasConflict) {
    sendJson(res, 409, { error: "store_cas_conflict", expected: error.expectedStatus, actual: error.actualStatus });
    return;
  }
  if (error instanceof StoreNotFound) {
    sendJson(res, 404, { error: "not_found", id: error.id });
    return;
  }
  if (error instanceof IdempotencyConflict) {
    sendJson(res, 422, { error: "idempotency_conflict", key: error.key });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/failed spec validation|required|invalid/i.test(message)) {
    sendJson(res, 400, { error: "bad_request", message });
    return;
  }
  sendJson(res, 500, { error: "internal_error", message });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "HttpError";
  }
}
