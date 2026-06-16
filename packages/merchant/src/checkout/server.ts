// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  assertValidEcJwk,
  canonicalMerchantAudience,
  systemClock,
  totalAmount,
  type EcJwk,
  type HmsAlgorithm,
  type Manifest,
  type Offer,
  type PurchaseIntent,
  type Total
} from "@steelyard/core";
import {
  ACP_API_VERSION_HEADER,
  ACP_VERSION,
  applyCancelRequest,
  applyCompleteRequest,
  applyCreateRequest,
  applyDiscountsRequest,
  applyUpdateRequest,
  buildAcpDiscovery,
  type CheckoutSessionCompleteRequest,
  type CheckoutSessionCreateRequest,
  type CheckoutSessionUpdateRequest,
  type AcpPaymentData,
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
import {
  UCP_AP2_CAPABILITY,
  UcpProfileCache,
  assertValidAp2EnvelopeOnResponse,
  isValidAp2EnvelopeOnRequest,
  signUcpResponse,
  verifyUcpRequest,
  type UcpProfileDoc,
  type UcpRequestVerificationFailureReason
} from "@steelyard/protocol/ucp";
import type {
  MandateVerificationResult,
  MandateVerifier,
  MerchantAuthorizationSigner,
  NonceStore
} from "../mandate/index.js";
import type { MerchantPolicy } from "../policy/index.js";
import type { PspAdapter, PspCaptureResult, PspPaymentMandate } from "../psp/index.js";
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
  ucp?: {
    auth?: {
      hms?: UcpHmsAuthConfig;
      bearer?: UcpBearerAuthConfig;
    };
    ap2?: UcpAp2Config;
    paymentHandlers?: string[];
    allowPrivateNetwork?: boolean;
    profileCache?: UcpProfileCache;
    responseSigningPolicy?: UcpResponseSigningPolicy;
  };
  acp?: {
    auth?: {
      bearer?: AcpBearerAuthConfig;
    };
    webhookSigningSecret?: string;
  };
  idempotency: IdempotencyStore;
  clock?: () => Date;
  merchantAudience?: string;
  baseUrl?: string;
}

export interface HmsSigningKey {
  kid: string;
  privateKeyJwk: EcJwk;
  algorithm: HmsAlgorithm;
}

export interface UcpHmsAuthConfig {
  enabled: boolean;
  signingKeys: HmsSigningKey[];
  activeKid: string;
}

export interface UcpAp2Config {
  enabled: boolean;
  mandateVerifier?: MandateVerifier;
  merchantAuthorizationSigner?: MerchantAuthorizationSigner;
  nonceStore?: NonceStore;
  nonceTtlSeconds?: number;
}

export type UcpBearerAuthResult =
  | { ok: true; subject?: string }
  | { ok: false; reason?: string };

export interface UcpBearerAuthConfig {
  enabled: boolean;
  verify: (token: string) => Promise<UcpBearerAuthResult> | UcpBearerAuthResult;
}

export type AcpBearerAuthResult = UcpBearerAuthResult;

export interface AcpBearerAuthConfig {
  enabled: boolean;
  verify: (token: string) => Promise<AcpBearerAuthResult> | AcpBearerAuthResult;
}

export type UcpResponseSigningPolicy = "high-value-only" | "all" | "off";

type UcpAuthConfig = NonNullable<NonNullable<MerchantCheckoutOpts["ucp"]>["auth"]>;
type UcpResponseKind = "normal" | "high-value";

export interface AcpRoutes {
  discovery(req: IncomingMessage, res: ServerResponse): Promise<void>;
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

export class UnknownPaymentHandlerError extends MerchantCheckoutConfigError {
  constructor(handlerId: string) {
    super(`unknown UCP payment handler: ${handlerId}`);
    this.name = "UnknownPaymentHandlerError";
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
  validateAcpConfig(protocols.has("acp") ? opts.acp : undefined);
  validateUcpConfig(protocols.has("ucp") ? opts.ucp : undefined);
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
  readonly ucpProfileCache: UcpProfileCache;

  constructor(
    readonly manifest: Manifest,
    readonly opts: MerchantCheckoutOpts
  ) {
    this.clock = opts.clock ?? systemClock;
    this.ucpProfileCache = opts.ucp?.profileCache ?? defaultUcpProfileCache;
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
    async discovery(req, res) {
      sendJson(res, 200, buildAcpDiscovery({
        apiBaseUrl: joinOriginPath(ctx.opts.baseUrl ?? requestUrl(req).origin, "/acp"),
        supportedCurrencies: offerCurrencies(ctx.manifest)
      }));
    },
    async createSession(req, res) {
      await withAcpJsonIdempotency(ctx, req, res, "acp:create", async (body) => {
        const policy = await ctx.evaluatePolicy("acp", body);
        if (policy) return policy;
        const now = ctx.clock();
        const result = applyCreateRequest(body as CheckoutSessionCreateRequest, {
          manifest: ctx.manifest,
          now,
          sessionId: `cs_${randomUUID()}`
        });
        await ctx.opts.store.put(withAcpPaymentHandlers(result.next, ctx.opts.psp) as StoredCheckout);
        return { status: 201, body: withAcpPaymentHandlers(result.response, ctx.opts.psp) };
      });
    },
    async getSession(req, res) {
      const auth = await authenticateAcpRequest(ctx, req);
      if (!auth.ok) {
        sendAcpError(res, auth.status, auth.code, auth.message);
        return;
      }
      const id = pathId(req, "/acp/checkout_sessions/");
      const session = await requireSession(ctx.opts.store, id);
      sendJson(res, 200, session);
    },
    async updateSession(req, res) {
      const id = pathId(req, "/acp/checkout_sessions/");
      await withAcpJsonIdempotency(ctx, req, res, `acp:update:${id}`, async (body) => {
        const current = await requireSession(ctx.opts.store, id);
        const policy = await ctx.evaluatePolicy("acp", body);
        if (policy) return policy;
        const result = applyUpdateRequest(current as CheckoutSession, body as CheckoutSessionUpdateRequest, {
          now: ctx.clock()
        });
        await ctx.opts.store.put(result.next as StoredCheckout);
        return { status: 200, body: result.response };
      });
    },
    async completeSession(req, res) {
      const id = pathId(req, "/acp/checkout_sessions/", "/complete");
      await withAcpJsonIdempotency(ctx, req, res, `acp:complete:${id}`, async (body, idempotencyKey) => {
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
          const completed = applyCompleteRequest(claimed as CheckoutSession, body as CheckoutSessionCompleteRequest, {
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
      await withAcpJsonIdempotency(ctx, req, res, `acp:cancel:${id}`, async (body) => {
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
      await withUcpJsonIdempotency(ctx, req, res, "ucp:create", "normal", async (body, _idempotencyKey, auth) => {
        const policy = await ctx.evaluatePolicy("ucp", body);
        if (policy) return policy;
        const ap2Locked = await ucpAp2Locked(ctx, auth);
        const checkoutId = `checkout_${randomUUID()}`;
        const result = applyUcpCreate(body as Partial<UcpCheckout>, {
          now: ctx.clock(),
          checkoutId,
          currency: checkoutCurrency(ctx.manifest),
          links: []
        });
        const checkout = withUcpCatalogDetails(ctx.manifest, result.next);
        const next = withUcpPaymentHandlers(
          ap2Locked
            ? { ...checkout, ap2_locked: true, ap2_nonces: await issueUcpAp2Nonces(ctx, checkoutId) }
            : checkout,
          ctx.opts.ucp?.paymentHandlers
        );
        await ctx.opts.store.put(next as StoredCheckout);
        return { status: 200, body: await prepareUcpCheckoutResponse(ctx, next) };
      });
    },
    async getCheckout(req, res) {
      const id = ucpCheckoutId(req);
      const checkout = await requireSession(ctx.opts.store, id);
      await sendUcpJsonResponse(ctx, res, 200, await prepareUcpCheckoutResponse(ctx, checkout), "normal");
    },
    async updateCheckout(req, res) {
      const id = ucpCheckoutId(req);
      await withUcpJsonIdempotency(ctx, req, res, `ucp:update:${id}`, "normal", async (body) => {
        const current = await requireSession(ctx.opts.store, id);
        const policy = await ctx.evaluatePolicy("ucp", body);
        if (policy) return policy;
        const result = applyUcpUpdate(current as UcpCheckout, body as Partial<UcpCheckout>, { now: ctx.clock() });
        const next = withUcpCatalogDetails(ctx.manifest, result.next);
        await ctx.opts.store.put(next as StoredCheckout);
        return { status: 200, body: await prepareUcpCheckoutResponse(ctx, next) };
      });
    },
    async completeCheckout(req, res) {
      const id = ucpCheckoutId(req, "/complete");
      await withUcpJsonIdempotency(ctx, req, res, `ucp:complete:${id}`, "high-value", async (body, idempotencyKey) => {
        const current = await requireSession(ctx.opts.store, id);
        const policy = await ctx.evaluatePolicy("ucp", current);
        if (policy) return policy;
        if (current.ap2_locked === true && !isValidAp2EnvelopeOnRequest(body)) {
          return {
            status: 400,
            body: {
              code: "mandate_required",
              content: "AP2 checkout_mandate is required for this session"
            }
          };
        }
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
          const verifier = current.ap2_locked === true ? ctx.opts.ucp?.ap2?.mandateVerifier : mandateVerifier;
          let mandateOk: Extract<MandateVerificationResult, { ok: true }> | undefined;
          if (current.ap2_locked === true || ctx.opts.steelyardMandate) {
            const verificationScope = current.ap2_locked === true ? stringValue(claimed.id, id) : ctx.ucpAudience;
            const mandate = await verifier!.verify(
              body as Record<string, unknown>,
              { ...claimed, payment: (body as Record<string, unknown>).payment },
              verificationScope
            );
            if (!mandate.ok) {
              status = 400;
              return {
                next: checkoutCanceled(
                  claimed,
                  mandateFailureCode(mandate),
                  mandate.reason,
                  ctx.clock()
                )
              };
            }
            mandateOk = mandate;
          }
          const pspResult = await capture(ctx, "ucp", claimed, payment, idempotencyKey, mandateOk);
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
        return { status, body: await prepareUcpCheckoutResponse(ctx, next) };
      });
    },
    async cancelCheckout(req, res) {
      const id = ucpCheckoutId(req, "/cancel");
      await withUcpJsonIdempotency(ctx, req, res, `ucp:cancel:${id}`, "normal", async () => {
        const current = await requireSession(ctx.opts.store, id);
        const next = await ctx.opts.store.transition(id, current.status, "canceled", async (claimed) => {
          const canceled = applyUcpCancel(claimed as UcpCheckout, { now: ctx.clock() });
          return { next: canceled.next as StoredCheckout };
        });
        return { status: 200, body: await prepareUcpCheckoutResponse(ctx, next) };
      });
    }
  };
}

const defaultUcpProfileCache = new UcpProfileCache();

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: { acp?: AcpRoutes; ucp?: UcpRoutes }
): Promise<void> {
  const path = requestPath(req);
  if (routes.acp) {
    if (req.method === "GET" && path === "/.well-known/acp.json") return await routes.acp.discovery(req, res);
    if (req.method === "POST" && path === "/acp/checkout_sessions") return await routes.acp.createSession(req, res);
    if (req.method === "GET" && /^\/acp\/checkout_sessions\/[^/]+$/.test(path)) {
      return await routes.acp.getSession(req, res);
    }
    if ((req.method === "POST" || req.method === "PATCH") && /^\/acp\/checkout_sessions\/[^/]+$/.test(path)) {
      return await routes.acp.updateSession(req, res);
    }
    if (req.method === "POST" && /^\/acp\/checkout_sessions\/[^/]+\/complete$/.test(path)) {
      return await routes.acp.completeSession(req, res);
    }
    if (req.method === "POST" && /^\/acp\/checkout_sessions\/[^/]+\/cancel$/.test(path)) {
      return await routes.acp.cancelSession(req, res);
    }
    if (req.method === "POST" && path === "/acp/discounts") return await routes.acp.discounts(req, res);
    if (
      req.method === "POST"
      && (path === "/agentic_commerce/delegate_payment" || path === "/acp/agentic_commerce/delegate_payment")
    ) {
      sendAcpError(res, 404, "acp_not_implemented", "ACP delegate_payment is not implemented in v0.6");
      return;
    }
  }

  if (routes.ucp) {
    if (req.method === "POST" && isUcpCheckoutCreatePath(path)) return await routes.ucp.createCheckout(req, res);
    if (req.method === "GET" && isUcpCheckoutResourcePath(path)) return await routes.ucp.getCheckout(req, res);
    if (req.method === "PATCH" && isUcpCheckoutResourcePath(path)) {
      return await routes.ucp.updateCheckout(req, res);
    }
    if (req.method === "POST" && isUcpCheckoutActionPath(path, "complete")) {
      return await routes.ucp.completeCheckout(req, res);
    }
    if (req.method === "POST" && isUcpCheckoutActionPath(path, "cancel")) {
      return await routes.ucp.cancelCheckout(req, res);
    }
  }

  sendJson(res, 404, { error: "not_found" });
}

async function withAcpJsonIdempotency(
  ctx: MerchantCheckoutContext,
  req: IncomingMessage,
  res: ServerResponse,
  scope: string,
  fn: (body: unknown, idempotencyKey: string) => Promise<IdempotencyResponse>
): Promise<void> {
  const auth = await authenticateAcpRequest(ctx, req);
  if (!auth.ok) {
    sendAcpError(res, auth.status, auth.code, auth.message);
    return;
  }

  const body = await readJsonBody(req);
  const key = idempotencyKey(req);
  if (!key) {
    sendAcpError(res, 400, "idempotency_key_required", "Idempotency-Key header is required");
    return;
  }
  const response = await ctx.opts.idempotency.remember(key, bodyHash(scope, body), () => fn(body, key));
  sendJson(res, response.status, response.body);
}

async function withUcpJsonIdempotency(
  ctx: MerchantCheckoutContext,
  req: IncomingMessage,
  res: ServerResponse,
  scope: string,
  responseKind: UcpResponseKind,
  fn: (body: unknown, idempotencyKey: string, auth: Extract<UcpAuthResult, { ok: true }>) => Promise<IdempotencyResponse>
): Promise<void> {
  const rawBody = await readRawBody(req);
  const auth = await authenticateUcpRequest(ctx, req, rawBody.byteLength ? rawBody : undefined);
  if (!auth.ok) {
    sendUcpAuthFailure(res, auth);
    return;
  }

  const body = parseJsonBody(rawBody);
  const key = idempotencyKey(req);
  if (!key) {
    sendJson(res, 400, { error: "idempotency_key_required" });
    return;
  }
  const response = await ctx.opts.idempotency.remember(key, bodyHash(scope, body), () => fn(body, key, auth));
  await sendUcpJsonResponse(ctx, res, response.status, response.body, responseKind);
}

async function sendUcpJsonResponse(
  ctx: MerchantCheckoutContext,
  res: ServerResponse,
  status: number,
  body: unknown,
  kind: UcpResponseKind
): Promise<void> {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signing = shouldSignUcpResponse(ctx, kind) ? activeUcpSigningKey(ctx) : undefined;
  if (!signing) {
    res.writeHead(status, headers);
    res.end(rawBody);
    return;
  }

  const signed = await signUcpResponse({
    status,
    headers,
    body: rawBody,
    signing,
    now: ctx.clock()
  });
  res.writeHead(status, signed.headers);
  res.end(rawBody);
}

function shouldSignUcpResponse(ctx: MerchantCheckoutContext, kind: UcpResponseKind): boolean {
  const policy = ctx.opts.ucp?.responseSigningPolicy ?? "high-value-only";
  if (policy === "off") return false;
  if (policy === "all") return true;
  return kind === "high-value";
}

function activeUcpSigningKey(ctx: MerchantCheckoutContext): { kid: string; algorithm: HmsAlgorithm; privateKey: EcJwk } | undefined {
  const hms = ctx.opts.ucp?.auth?.hms;
  if (hms?.enabled !== true) return undefined;
  const active = hms.signingKeys.find((key) => key.kid === hms.activeKid);
  if (!active) return undefined;
  return {
    kid: active.kid,
    algorithm: active.algorithm,
    privateKey: active.privateKeyJwk
  };
}

async function prepareUcpCheckoutResponse(
  ctx: MerchantCheckoutContext,
  checkout: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const publicCheckout = publicUcpCheckout(checkout);
  if (ctx.opts.ucp?.ap2?.enabled !== true || checkout.ap2_locked !== true) return publicCheckout;

  const signer = ctx.opts.ucp.ap2.merchantAuthorizationSigner;
  if (!signer) {
    throw new MerchantCheckoutConfigError("ucp.ap2.merchantAuthorizationSigner is required when AP2 is enabled");
  }

  const merchantAuthorization = await signer.sign(publicCheckout);
  const nonces = ap2NonceFields(checkout);
  const response = {
    ...publicCheckout,
    ap2: {
      ...asRecord(publicCheckout.ap2),
      ...nonces,
      merchant_authorization: merchantAuthorization
    }
  };
  assertValidAp2EnvelopeOnResponse(response);
  return response;
}

function publicUcpCheckout(checkout: Record<string, unknown>): Record<string, unknown> {
  const { ap2_locked: _ap2Locked, ap2_nonces: _ap2Nonces, ...publicCheckout } = checkout;
  return publicCheckout;
}

async function issueUcpAp2Nonces(ctx: MerchantCheckoutContext, checkoutId: string): Promise<Record<string, unknown>> {
  const store = ctx.opts.ucp?.ap2?.nonceStore;
  if (!store) throw new MerchantCheckoutConfigError("ucp.ap2.nonceStore is required when AP2 is enabled");
  const ttlSeconds = ctx.opts.ucp?.ap2?.nonceTtlSeconds;
  const checkout = await store.issue({ session_id: checkoutId, ...(ttlSeconds ? { ttlSeconds } : {}) });
  const payment = await store.issue({ session_id: checkoutId, ...(ttlSeconds ? { ttlSeconds } : {}) });
  return {
    checkout_nonce: checkout.nonce,
    checkout_nonce_expires_at: checkout.expires_at,
    payment_nonce: payment.nonce,
    payment_nonce_expires_at: payment.expires_at
  };
}

function ap2NonceFields(checkout: Record<string, unknown>): Record<string, unknown> {
  const nonces = asRecord(checkout.ap2_nonces);
  const checkoutNonce = stringValue(nonces.checkout_nonce, "");
  const paymentNonce = stringValue(nonces.payment_nonce, "");
  return {
    ...(checkoutNonce ? { checkout_nonce: checkoutNonce } : {}),
    ...(typeof nonces.checkout_nonce_expires_at === "string"
      ? { checkout_nonce_expires_at: nonces.checkout_nonce_expires_at }
      : {}),
    ...(paymentNonce ? { payment_nonce: paymentNonce } : {}),
    ...(typeof nonces.payment_nonce_expires_at === "string" ? { payment_nonce_expires_at: nonces.payment_nonce_expires_at } : {})
  };
}

async function ucpAp2Locked(
  ctx: MerchantCheckoutContext,
  auth: Extract<UcpAuthResult, { ok: true }>
): Promise<boolean> {
  if (ctx.opts.ucp?.ap2?.enabled !== true) return false;
  if (auth.mechanism !== "hms" || !auth.signerProfileUrl) return false;
  const buyerProfile = await ctx.ucpProfileCache.get(auth.signerProfileUrl, {
    allowPrivateNetwork: ctx.opts.ucp?.allowPrivateNetwork,
    now: ctx.clock
  });
  return ucpProfileHasCapability(buyerProfile, UCP_AP2_CAPABILITY);
}

function ucpProfileHasCapability(profile: UcpProfileDoc, capability: string): boolean {
  const value = profile.ucp.capabilities?.[capability];
  return Array.isArray(value) && value.length > 0;
}

async function capture(
  ctx: MerchantCheckoutContext,
  protocol: "acp" | "ucp",
  session: StoredCheckout,
  payment: { vault_token: string; handler_id: string; payment_mandate_token?: string },
  _httpIdempotencyKey: string,
  mandateOk?: Extract<MandateVerificationResult, { ok: true }>
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
    handler_id: payment.handler_id,
    ...(payment.payment_mandate_token
      ? { payment_mandate: ap2PaymentMandateForCapture(ctx, session, payment.payment_mandate_token, mandateOk) }
      : {})
  });
}

function ap2PaymentMandateForCapture(
  ctx: MerchantCheckoutContext,
  session: StoredCheckout,
  token: string,
  mandateOk: Extract<MandateVerificationResult, { ok: true }> | undefined
): PspPaymentMandate {
  if (!mandateOk) throw new HttpError(400, "mandate_required");
  const claims = asRecord(asRecord(mandateOk).claims);
  const holderJwk = asRecord(asRecord(claims.cnf).jwk);
  const checkout = asRecord(asRecord(mandateOk).checkout);
  const merchantAuthorization = stringValue(asRecord(asRecord(checkout).ap2).merchant_authorization, "");
  if (!merchantAuthorization) throw new HttpError(400, "merchant_authorization_missing");
  const exp = typeof claims.exp === "number" && Number.isSafeInteger(claims.exp)
    ? claims.exp
    : Math.floor(ctx.clock().getTime() / 1000) + 300;

  return {
    format: "ap2-sd-jwt-kb",
    payload: token,
    holder_jwk: assertValidEcJwk(holderJwk),
    payment_intent: {
      amount: totalAmount(totals(session)),
      currency: stringValue(session.currency, checkoutCurrency(ctx.manifest)),
      checkout_id: session.id,
      expires_at: new Date(exp * 1000).toISOString(),
      transaction_id: createHash("sha256").update(Buffer.from(merchantAuthorization, "utf8")).digest("base64url")
    }
  };
}

async function requireSession(store: CheckoutSessionStore, id: string): Promise<StoredCheckout> {
  const session = await store.get(id);
  if (!session) throw new StoreNotFound(id);
  return session;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return parseJsonBody(await readRawBody(req));
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJsonBody(rawBody: Buffer): unknown {
  const raw = rawBody.toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

type UcpAuthFailureCode =
  | UcpRequestVerificationFailureReason
  | "auth_missing"
  | "auth_method_not_supported"
  | "auth_invalid";

type UcpAuthResult =
  | { ok: true; mechanism: "none" | "hms" | "bearer"; subject?: string; signerProfileUrl?: string }
  | { ok: false; status: number; code: UcpAuthFailureCode; content: string };

async function authenticateUcpRequest(
  ctx: MerchantCheckoutContext,
  req: IncomingMessage,
  body: Uint8Array | undefined
): Promise<UcpAuthResult> {
  const auth = ctx.opts.ucp?.auth;
  if (!auth) return { ok: true, mechanism: "none" };

  const headers = incomingHeaders(req);
  const hasSignature = !!headers["signature-input"];
  if (hasSignature) {
    if (auth.hms?.enabled !== true) {
      return {
        ok: false,
        status: 401,
        code: "auth_method_not_supported",
        content: "UCP HTTP Message Signatures are not enabled for this merchant"
      };
    }
    const verification = await verifyUcpRequest({
      method: req.method ?? "GET",
      url: requestUrl(req),
      headers,
      body,
      resolveKey: (kid, signerProfileUrl) =>
        ctx.ucpProfileCache.resolveSigningKey(signerProfileUrl, kid, {
          allowPrivateNetwork: ctx.opts.ucp?.allowPrivateNetwork,
          now: ctx.clock
        }),
      now: ctx.clock()
    });
    if (!verification.ok) {
      return {
        ok: false,
        status: ucpSignatureFailureStatus(verification.reason),
        code: verification.reason,
        content: `Signature verification failed: ${verification.detail ?? verification.reason}`
      };
    }
    return { ok: true, mechanism: "hms", subject: verification.signerProfileUrl, signerProfileUrl: verification.signerProfileUrl };
  }

  const token = bearerToken(headers.authorization);
  if (token) {
    if (auth.bearer?.enabled !== true) {
      return {
        ok: false,
        status: 401,
        code: "auth_method_not_supported",
        content: "UCP bearer auth is not enabled for this merchant"
      };
    }
    const result = await auth.bearer.verify(token);
    if (!result.ok) {
      return {
        ok: false,
        status: 401,
        code: "auth_invalid",
        content: result.reason ?? "Bearer token verification failed"
      };
    }
    return { ok: true, mechanism: "bearer", subject: result.subject };
  }

  return {
    ok: false,
    status: 401,
    code: "auth_missing",
    content: "UCP request requires HTTP Message Signatures or bearer auth"
  };
}

function sendUcpAuthFailure(res: ServerResponse, failure: Extract<UcpAuthResult, { ok: false }>): void {
  sendJson(res, failure.status, { code: failure.code, content: failure.content });
}

function ucpSignatureFailureStatus(reason: UcpRequestVerificationFailureReason): number {
  return reason === "digest_mismatch" || reason === "algorithm_unsupported" ? 400 : 401;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

function incomingHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length) headers[name.toLowerCase()] = value.join(", ");
  }
  return headers;
}

type AcpAuthResult =
  | { ok: true; subject?: string }
  | { ok: false; status: number; code: string; message: string };

async function authenticateAcpRequest(ctx: MerchantCheckoutContext, req: IncomingMessage): Promise<AcpAuthResult> {
  const headers = incomingHeaders(req);
  const apiVersion = headers[ACP_API_VERSION_HEADER.toLowerCase()];
  if (apiVersion !== ACP_VERSION) {
    return {
      ok: false,
      status: 400,
      code: "acp_api_version_required",
      message: `ACP requests require ${ACP_API_VERSION_HEADER}: ${ACP_VERSION}`
    };
  }

  const bearer = ctx.opts.acp?.auth?.bearer;
  if (bearer?.enabled !== true) return { ok: true };
  const token = bearerToken(headers.authorization);
  if (!token) {
    return { ok: false, status: 401, code: "auth_missing", message: "ACP request requires bearer auth" };
  }
  const verified = await bearer.verify(token);
  if (!verified.ok) {
    return { ok: false, status: 401, code: "auth_invalid", message: verified.reason ?? "Bearer token verification failed" };
  }
  return { ok: true, subject: verified.subject };
}

function requestUrl(req: IncomingMessage): URL {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  return new URL(req.url ?? "/", `http://${host ?? "localhost"}`);
}

function isUcpCheckoutCreatePath(path: string): boolean {
  return path === "/ucp/api/checkout" || path === "/api/checkout";
}

function isUcpCheckoutResourcePath(path: string): boolean {
  return /^\/(?:ucp\/)?api\/checkout\/[^/]+$/.test(path);
}

function isUcpCheckoutActionPath(path: string, action: "complete" | "cancel"): boolean {
  return new RegExp(`^/(?:ucp/)?api/checkout/[^/]+/${action}$`).test(path);
}

function ucpCheckoutId(req: IncomingMessage, suffix = ""): string {
  const path = requestPath(req);
  const prefix = path.startsWith("/ucp/api/checkout/") ? "/ucp/api/checkout/" : "/api/checkout/";
  return pathId(req, prefix, suffix);
}

function acpPaymentData(body: unknown): { vault_token: string; handler_id: string } {
  const paymentData = asRecord(asRecord(body).payment_data) as Record<string, unknown> & AcpPaymentData;
  const instrument = asRecord(paymentData.instrument);
  const credential = asRecord(instrument.credential);
  const token = stringValue(credential.token, "");
  const handlerId = stringValue(paymentData.handler_id, "");
  if (!handlerId) throw new HttpError(400, "payment_handler_required");
  if (handlerId !== "stripe") throw new HttpError(400, "acp_unknown_handler");
  if (stringValue(instrument.type, "") !== "card") throw new HttpError(400, "acp_unsupported_instrument_type");
  if (stringValue(credential.type, "") !== "spt") throw new HttpError(400, "acp_unsupported_credential_type");
  if (!/^spt_/.test(token)) throw new HttpError(400, "acp_invalid_credential_token");
  return { vault_token: token, handler_id: handlerId };
}

function mandateErrorCode(reason: string): string {
  if (reason === "audience_mismatch") return "mandate_audience_mismatch";
  if (reason === "missing_mandate") return "mandate_required";
  return "mandate_invalid";
}

function mandateFailureCode(result: Extract<MandateVerificationResult, { ok: false }>): string {
  const code = asRecord(result).code;
  if (typeof code === "string" && code) return code;
  return mandateErrorCode(result.reason);
}

function ucpPaymentData(body: unknown): { vault_token: string; handler_id: string; payment_mandate_token?: string } {
  const payment = asRecord(asRecord(body).payment);
  const instruments = payment.instruments;
  if (!Array.isArray(instruments)) throw new HttpError(400, "payment_instrument_required");
  const selected = instruments.map(asRecord).find((instrument) => instrument.selected === true) ?? asRecord(instruments[0]);
  const credential = asRecord(selected.credential);
  const token = stringValue(credential.token, "");
  const handlerId = stringValue(selected.handler_id, "");
  if (!token) throw new HttpError(400, "vault_token_required");
  if (!handlerId) throw new HttpError(400, "payment_handler_required");
  const credentialType = stringValue(credential.type, "");
  return {
    vault_token: token,
    handler_id: handlerId,
    ...(credentialType === "ap2_payment_mandate" ? { payment_mandate_token: token } : {})
  };
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
            name: "net.steelyard.stripe_spt",
            display_name: "Stripe Shared Payment Token",
            version: ACP_VERSION,
            spec: "https://steelyard.dev/specs/payment/stripe-spt",
            requires_delegate_payment: false,
            requires_pci_compliance: false,
            psp: psp.name,
            config_schema: "https://steelyard.dev/schemas/payment-handler-config.json",
            instrument_schemas: ["https://steelyard.dev/schemas/stripe-spt-instrument.json"],
            config: { instrument_type: "card", credential_type: "spt" }
          }
        ]
      }
    }
  };
}

function withUcpPaymentHandlers(checkout: Record<string, unknown>, paymentHandlers: readonly string[] | undefined): Record<string, unknown> {
  if (!paymentHandlers?.length) return checkout;
  return {
    ...checkout,
    ucp: {
      ...asRecord(checkout.ucp),
      payment_handlers: {
        "net.steelyard": paymentHandlers.map(ucpPaymentHandler)
      }
    }
  };
}

function ucpPaymentHandler(id: string): Record<string, unknown> {
  if (id !== "stripe") throw new UnknownPaymentHandlerError(id);
  return {
    id: "stripe",
    version: "2026-04-17",
    available_instruments: [
      { type: "card", constraints: { brands: ["visa", "mastercard", "amex"] } },
      { type: "shared_payment_token" }
    ]
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
      psp_status: pspResult.status,
      ...(pspResult.psp_charge_id ? { psp_charge_id: pspResult.psp_charge_id } : {}),
      ...(pspResult.psp_charge_status ? { psp_charge_status: pspResult.psp_charge_status } : {})
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

function validateUcpConfig(config: NonNullable<MerchantCheckoutOpts["ucp"]> | undefined): void {
  validateUcpAuthConfig(config?.auth);
  validateUcpAp2Config(config);
  validateUcpPaymentHandlers(config?.paymentHandlers);
}

function validateAcpConfig(config: NonNullable<MerchantCheckoutOpts["acp"]> | undefined): void {
  if (config?.auth?.bearer?.enabled && typeof config.auth.bearer.verify !== "function") {
    throw new MerchantCheckoutConfigError("acp.auth.bearer.verify is required when bearer auth is enabled");
  }
}

function validateUcpPaymentHandlers(paymentHandlers: readonly string[] | undefined): void {
  for (const handler of paymentHandlers ?? []) {
    if (handler !== "stripe") throw new UnknownPaymentHandlerError(handler);
  }
}

function validateUcpAuthConfig(config: UcpAuthConfig | undefined): void {
  validateUcpHmsAuthConfig(config?.hms);
  if (config?.bearer?.enabled && typeof config.bearer.verify !== "function") {
    throw new MerchantCheckoutConfigError("ucp.auth.bearer.verify is required when bearer auth is enabled");
  }
}

function validateUcpAp2Config(config: NonNullable<MerchantCheckoutOpts["ucp"]> | undefined): void {
  if (config?.ap2?.enabled !== true) return;
  const hms = config.auth?.hms;
  if (hms?.enabled !== true || !Array.isArray(hms.signingKeys) || hms.signingKeys.length === 0) {
    throw new MerchantCheckoutConfigError("ucp.auth.hms.signingKeys is required when AP2 is enabled");
  }
  if (!config.ap2.merchantAuthorizationSigner) {
    throw new MerchantCheckoutConfigError("ucp.ap2.merchantAuthorizationSigner is required when AP2 is enabled");
  }
  if (!config.ap2.mandateVerifier) {
    throw new MerchantCheckoutConfigError("ucp.ap2.mandateVerifier is required when AP2 is enabled");
  }
  if (!config.ap2.nonceStore) {
    throw new MerchantCheckoutConfigError("ucp.ap2.nonceStore is required when AP2 is enabled");
  }
}

function validateUcpHmsAuthConfig(config: UcpHmsAuthConfig | undefined): void {
  if (!config?.enabled) return;
  if (!Array.isArray(config.signingKeys) || config.signingKeys.length === 0) {
    throw new MerchantCheckoutConfigError("ucp.auth.hms.signingKeys is required when HMS is enabled");
  }

  let activeFound = false;
  const seenKids = new Set<string>();
  for (const signingKey of config.signingKeys) {
    if (seenKids.has(signingKey.kid)) {
      throw new MerchantCheckoutConfigError(`duplicate HMS signing key kid: ${signingKey.kid}`);
    }
    seenKids.add(signingKey.kid);

    const jwk = assertValidEcJwk(signingKey.privateKeyJwk, { allowPrivate: true });
    if (!jwk.d) throw new MerchantCheckoutConfigError(`HMS signing key ${signingKey.kid} must include private d`);
    if (signingKey.kid !== jwk.kid) {
      throw new MerchantCheckoutConfigError(`HMS signing key ${signingKey.kid} must match privateKeyJwk.kid`);
    }
    const expected = jwk.crv === "P-256" ? "ES256" : "ES384";
    if (signingKey.algorithm !== expected) {
      throw new MerchantCheckoutConfigError(`HMS signing key ${signingKey.kid} algorithm must be ${expected}`);
    }
    if (signingKey.kid === config.activeKid) activeFound = true;
  }

  if (!activeFound) {
    throw new MerchantCheckoutConfigError("ucp.auth.hms.activeKid must match a configured signing key");
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

function joinOriginPath(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
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
    if (error.code.startsWith("acp_")) {
      sendAcpError(res, error.status, error.code, error.code);
      return;
    }
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

function sendAcpError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, {
    type: status >= 500 ? "processing_error" : "invalid_request",
    code,
    message
  });
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
