// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import { SDJwtInstance } from "@sd-jwt/core";
import { ecdsaSignRaw, signDetachedJws, type EcJwk, type HmsAlgorithm } from "@steelyard-dev/core";
import { describe, expect, it } from "vitest";
import {
  MockInProductionError,
  PspConfigError,
  REFERENCE_PAYMENT_INSTRUMENT_TYPE,
  REFERENCE_PAYMENT_TOKEN_PREFIX,
  ReferencePspInProductionError,
  StripeLiveDisabledError,
  mockPsp,
  mockVaultToken,
  referencePsp,
  stripePsp,
  type PspCaptureArgs
} from "./index.js";

const captureArgs: PspCaptureArgs = {
  vault_token: "vt_1",
  amount: 500,
  currency: "USD",
  metadata: { purchase_key: "purchase_1" },
  idempotencyKey: "idem_1",
  session_id: "cs_1",
  merchant_id: "merchant_1",
  handler_id: "handler_1"
};
const now = new Date("2026-06-14T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

describe("mockPsp", () => {
  it("is default-deny outside known test environments", async () => {
    await withMockEnv({}, async () => {
      expect(() => mockPsp()).toThrow(MockInProductionError);
      expect(() => mockPsp({ allowInProduction: true })).toThrow(MockInProductionError);
      process.env.STEELYARD_ALLOW_MOCK_PSP = "1";
      expect(() => mockPsp()).toThrow(MockInProductionError);
      expect(() => mockPsp({ allowInProduction: true })).not.toThrow();
    });
  });

  it("allows stable test environment signals", async () => {
    await withMockEnv({ STEELYARD_TEST: "1" }, async () => {
      expect(() => mockPsp()).not.toThrow();
    });
  });

  it("returns deterministic captures and vault tokens", async () => {
    await withMockEnv({ STEELYARD_TEST: "1" }, async () => {
      const psp = mockPsp({ seed: "unit" });

      const first = await psp.capture(captureArgs);
      const replay = await psp.capture({ ...captureArgs, amount: 999 });

      expect(first).toEqual(replay);
      expect(first).toMatchObject({ ok: true, status: "captured" });
      if (first.ok) expect(first.psp_payment_id).toMatch(/^psp_payment_[a-f0-9]{24}$/);
      expect(mockVaultToken({ paymentMandate: "pm_1", idempotencyKey: "idem_1", seed: "unit" })).toMatch(
        /^vt_test_[a-f0-9]{24}$/
      );
      await expect(psp.cancel({ psp_payment_id: "psp_payment_1", idempotencyKey: "cancel_1" })).resolves.toBeUndefined();
    });
  });

  it("supports configured handlers and failure modes", async () => {
    await withMockEnv({ STEELYARD_TEST: "1" }, async () => {
      const declined = mockPsp({ handlerIds: ["handler_1"], failOn: "declined" });
      await expect(declined.capture(captureArgs)).resolves.toEqual({
        ok: false,
        reason: "declined",
        message: "mock PSP declined"
      });
      expect(declined.supportsHandler("handler_1")).toBe(true);
      expect(declined.supportsHandler("handler_2")).toBe(false);
      expect(declined.capabilities).toEqual([
        { handlerId: "handler_1", instrumentType: "vault_token", idPrefix: "vt_" }
      ]);

      const auth = mockPsp({ failOn: "requires_authentication" });
      await expect(auth.capture(captureArgs)).resolves.toMatchObject({
        ok: false,
        requires_authentication: true
      });
    });
  });

  it("validates required capture and cancel inputs", async () => {
    await withMockEnv({ STEELYARD_TEST: "1" }, async () => {
      const psp = mockPsp();
      await expect(psp.capture({ ...captureArgs, idempotencyKey: "" })).rejects.toBeInstanceOf(PspConfigError);
      await expect(psp.capture({ ...captureArgs, currency: "usd" })).rejects.toThrow(/currency/);
      await expect(psp.cancel({ psp_payment_id: "", idempotencyKey: "cancel_1" })).rejects.toThrow(/psp_payment_id/);
      expect(() => mockVaultToken({ paymentMandate: "", idempotencyKey: "idem" })).toThrow(/paymentMandate/);
    });
  });

  it("verifies AP2 payment mandates before mock capture (PM5-3)", async () => {
    await withMockEnv({ STEELYARD_TEST: "1" }, async () => {
      const paymentMandate = await issuePaymentMandate();
      const psp = mockPsp({ seed: "unit", clock: () => now });

      await expect(psp.capture({ ...captureArgs, payment_mandate: paymentMandate })).resolves.toMatchObject({
        ok: true,
        status: "captured"
      });
      await expect(
        psp.capture({
          ...captureArgs,
          idempotencyKey: "idem_ap2_bad_amount",
          payment_mandate: {
            ...paymentMandate,
            payment_intent: { ...paymentMandate.payment_intent, amount: 999 }
          }
        })
      ).rejects.toThrow(/amount_mismatch/);
    });
  });

  it("rejects malformed AP2 payment mandates before mock capture", async () => {
    await withMockEnv({ STEELYARD_TEST: "1" }, async () => {
      const paymentMandate = await issuePaymentMandate();
      const psp = mockPsp({ seed: "unit", clock: () => now });
      const cases: [string, NonNullable<PspCaptureArgs["payment_mandate"]>][] = [
        ["shape_invalid", { ...paymentMandate, payload: "" }],
        ["holder_key_invalid", { ...paymentMandate, holder_jwk: { ...holderP256PrivateKey } }],
        [
          "transaction_mismatch",
          { ...paymentMandate, payment_intent: { ...paymentMandate.payment_intent, transaction_id: undefined } }
        ],
        [
          "currency_mismatch",
          { ...paymentMandate, payment_intent: { ...paymentMandate.payment_intent, currency: "EUR" } }
        ],
        ["expired", { ...paymentMandate, payment_intent: { ...paymentMandate.payment_intent, expires_at: now.toISOString() } }]
      ];

      for (const [reason, invalidMandate] of cases) {
        await expect(
          psp.capture({
            ...captureArgs,
            idempotencyKey: `idem_ap2_${reason}`,
            payment_mandate: invalidMandate
          })
        ).rejects.toThrow(reason);
      }
      await expect(
        mockPsp({ seed: "unit", clock: () => new Date(now.getTime() + 16 * 60_000) })
          .capture({ ...captureArgs, idempotencyKey: "idem_ap2_expired", payment_mandate: paymentMandate })
      ).rejects.toThrow(/expired/);
    });
  });
});

describe("referencePsp", () => {
  it("is default-deny outside known test environments", async () => {
    await withMockEnv({}, async () => {
      expect(() => referencePsp({ signingKey: holderP256PublicKey })).toThrow(ReferencePspInProductionError);
      expect(() => referencePsp({ signingKey: holderP256PublicKey, allowInProduction: true }))
        .toThrow(ReferencePspInProductionError);
      process.env.STEELYARD_ALLOW_REFERENCE_PSP = "1";
      expect(() => referencePsp({ signingKey: holderP256PublicKey })).toThrow(ReferencePspInProductionError);
      expect(() => referencePsp({ signingKey: holderP256PublicKey, allowInProduction: true })).not.toThrow();
    });
  });

  it("declares reference delegated-token capability and captures valid tokens", async () => {
    const psp = referencePsp({ signingKey: holderP256PublicKey, clock: () => now });
    const token = await issueReferenceToken();

    expect(psp.name).toBe("reference");
    expect(psp.capabilities).toEqual([
      { handlerId: "reference", instrumentType: REFERENCE_PAYMENT_INSTRUMENT_TYPE, idPrefix: REFERENCE_PAYMENT_TOKEN_PREFIX }
    ]);
    expect(psp.supportsHandler("reference")).toBe(true);
    expect(psp.supportsHandler("stripe")).toBe(false);
    await expect(psp.capture(referenceCaptureArgs(token))).resolves.toMatchObject({
      ok: true,
      psp_payment_id: expect.stringMatching(/^psp_reference_[a-f0-9]{24}$/),
      status: "captured"
    });
  });

  it("rejects forged or context-mismatched reference tokens at capture (RP2)", async () => {
    const psp = referencePsp({ signingKey: holderP256PublicKey, clock: () => now });
    const wrongAmount = await issueReferenceToken({ amount: 999 });
    const wrongMerchant = await issueReferenceToken({ merchant_id: "https://wrong.example/.well-known/ucp" });
    const expired = await issueReferenceToken({ exp: nowSeconds - 1 });
    const altered = alterReferenceToken(await issueReferenceToken(), { currency: "EUR" });

    await expect(psp.capture(referenceCaptureArgs(wrongAmount, "idem_reference_amount"))).resolves.toMatchObject({
      ok: false,
      reason: "other",
      detail: "reference_token_amount_mismatch"
    });
    await expect(psp.capture(referenceCaptureArgs(wrongMerchant, "idem_reference_merchant"))).resolves.toMatchObject({
      ok: false,
      reason: "other",
      detail: "reference_token_merchant_mismatch"
    });
    await expect(psp.capture(referenceCaptureArgs(expired, "idem_reference_expired"))).resolves.toMatchObject({
      ok: false,
      reason: "expired",
      detail: "reference_token_expired"
    });
    await expect(psp.capture(referenceCaptureArgs(altered, "idem_reference_altered"))).resolves.toMatchObject({
      ok: false,
      reason: "other",
      detail: "reference_token_signature_invalid"
    });
  });
});

describe("stripePsp", () => {
  it("requires an explicit API key and handler match", () => {
    expect(() => stripePsp({ apiKey: "" })).toThrow(/apiKey/);
    expect(() => stripePsp({ apiKey: "sk_live_unit" })).toThrow(StripeLiveDisabledError);
    expect(() => stripePsp({ apiKey: "rk_test_unit", acceptSharedPaymentTokens: true })).toThrow(StripeLiveDisabledError);
    const psp = stripePsp({ apiKey: "sk_test_unit", fetch: async () => stripeResponse({ id: "pi_1", status: "succeeded" }) });
    expect(psp.name).toBe("stripe");
    expect(psp.capabilities).toEqual([
      { handlerId: "stripe", instrumentType: "shared_payment_token", idPrefix: "spt_" }
    ]);
    expect(psp.supportsHandler("stripe")).toBe(true);
    expect(psp.supportsHandler("other")).toBe(false);
  });

  it("passes idempotency, metadata, and token fields to Stripe capture", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const psp = stripePsp({
      apiKey: "sk_test_unit",
      apiBaseUrl: "https://stripe.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return stripeResponse({ id: "pi_1", status: "succeeded" });
      }
    });

    await expect(psp.capture(captureArgs)).resolves.toEqual({
      ok: true,
      psp_payment_id: "pi_1",
      status: "captured"
    });

    expect(calls[0]!.url).toBe("https://stripe.test/v1/payment_intents");
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("idem_1");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_unit");
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("amount")).toBe("500");
    expect(body.get("currency")).toBe("usd");
    expect(body.get("payment_method")).toBe("vt_1");
    expect(body.get("metadata[purchase_key]")).toBe("purchase_1");
  });

  it("rejects SPT capture unless explicitly enabled (SC1)", async () => {
    const psp = stripePsp({
      apiKey: "sk_test_unit",
      fetch: async () => stripeResponse({ id: "pi_1", status: "succeeded" })
    });

    await expect(psp.capture({ ...captureArgs, vault_token: "spt_123" })).rejects.toThrow(/STRIPE_SPT_NOT_ENABLED/);
  });

  it("charges SPTs through the shared preview helper when enabled (SC1, SC2, SC4)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const psp = stripePsp({
      apiKey: "sk_test_unit",
      apiBaseUrl: "https://stripe.test",
      acceptSharedPaymentTokens: true,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return stripeResponse({
          id: "pi_spt",
          status: "succeeded",
          charges: { data: [{ id: "ch_spt", status: "succeeded" }] }
        });
      }
    });

    await expect(psp.capture({ ...captureArgs, vault_token: "spt_123" })).resolves.toEqual({
      ok: true,
      psp_payment_id: "pi_spt",
      psp_charge_id: "ch_spt",
      psp_charge_status: "succeeded",
      status: "captured"
    });

    expect(calls[0]!.url).toBe("https://stripe.test/v1/payment_intents");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers["Stripe-Version"]).toBe("2026-04-22.preview");
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("payment_method_data[shared_payment_granted_token]")).toBe("spt_123");
    expect(body.get("payment_method")).toBeNull();
  });

  it("surfaces Stripe SPT decline details through neutral PSP reasons (NC3)", async () => {
    const cases: Array<[string, string, string | undefined]> = [
      ["spt_max_amount_exceeded", "limit_exceeded", "amount_exceeded"],
      ["spt_revoked", "revoked", "spt_revoked"],
      ["spt_seller_mismatch", "seller_mismatch", "spt_seller_mismatch"],
      ["card_declined", "declined", undefined]
    ];

    for (const [stripeCode, reason, detail] of cases) {
      await expect(
        stripePsp({
          apiKey: "sk_test_unit",
          acceptSharedPaymentTokens: true,
          fetch: async () => stripeResponse({ error: { code: stripeCode, message: stripeCode } }, 402)
        }).capture({ ...captureArgs, vault_token: "spt_123" })
      ).resolves.toEqual({
        ok: false,
        reason,
        message: stripeCode,
        ...(detail ? { detail } : {})
      });
    }
  });

  it("uses an SPT embedded in a verified AP2 payment mandate (AP1, SC1)", async () => {
    const paymentMandate = await issuePaymentMandate({
      handlerId: "stripe",
      paymentInstrument: {
        id: "spt_123",
        type: "shared_payment_token",
        description: "Stripe Shared Payment Token (test mode)"
      }
    });
    const calls: { url: string; init: RequestInit }[] = [];
    const psp = stripePsp({
      apiKey: "sk_test_unit",
      apiBaseUrl: "https://stripe.test",
      acceptSharedPaymentTokens: true,
      clock: () => now,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return stripeResponse({ id: "pi_spt", status: "succeeded" });
      }
    });

    await expect(psp.capture({ ...captureArgs, handler_id: "stripe", payment_mandate: paymentMandate })).resolves.toMatchObject({
      ok: true,
      psp_payment_id: "pi_spt"
    });
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("payment_method_data[shared_payment_granted_token]")).toBe("spt_123");
  });

  it("rejects SPT AP2 payment mandates whose handler claim is missing or mismatched (UH4)", async () => {
    const psp = stripePsp({
      apiKey: "sk_test_unit",
      acceptSharedPaymentTokens: true,
      clock: () => now,
      fetch: async () => stripeResponse({ id: "pi_unreachable", status: "succeeded" })
    });
    const paymentInstrument = {
      id: "spt_123",
      type: "shared_payment_token",
      description: "Stripe Shared Payment Token (test mode)"
    };
    const missing = await issuePaymentMandate({ paymentInstrument });
    const mismatched = await issuePaymentMandate({ handlerId: "other", paymentInstrument });

    await expect(
      psp.capture({ ...captureArgs, handler_id: "stripe", idempotencyKey: "idem_ap2_spt_missing_handler", payment_mandate: missing })
    ).rejects.toThrow(/handler_mismatch/);
    await expect(
      psp.capture({
        ...captureArgs,
        handler_id: "stripe",
        idempotencyKey: "idem_ap2_spt_mismatched_handler",
        payment_mandate: mismatched
      })
    ).rejects.toThrow(/handler_mismatch/);
  });

  it("verifies AP2 payment mandates before Stripe capture (PM5-3)", async () => {
    const paymentMandate = await issuePaymentMandate();
    const calls: { url: string; init: RequestInit }[] = [];
    const psp = stripePsp({
      apiKey: "sk_test_unit",
      apiBaseUrl: "https://stripe.test",
      clock: () => now,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return stripeResponse({ id: "pi_1", status: "succeeded" });
      }
    });

    await expect(psp.capture({ ...captureArgs, payment_mandate: paymentMandate })).resolves.toMatchObject({
      ok: true,
      psp_payment_id: "pi_1"
    });
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("payment_method")).toBe("card_1");
    await expect(
      psp.capture({
        ...captureArgs,
        idempotencyKey: "idem_ap2_bad_transaction",
        payment_mandate: {
          ...paymentMandate,
          payment_intent: { ...paymentMandate.payment_intent, transaction_id: "wrong" }
        }
      })
    ).rejects.toThrow(/transaction_mismatch/);
    expect(calls).toHaveLength(1);
  });

  it("maps Stripe statuses and errors", async () => {
    await expect(
      stripePsp({
        apiKey: "sk_test_unit",
        fetch: async () => stripeResponse({ id: "pi_2", status: "requires_capture" })
      }).capture(captureArgs)
    ).resolves.toEqual({ ok: true, psp_payment_id: "pi_2", status: "authorized" });

    await expect(
      stripePsp({
        apiKey: "sk_test_unit",
        fetch: async () =>
          stripeResponse({
            id: "pi_3",
            status: "requires_action",
            next_action: { redirect_to_url: { url: "https://stripe.test/auth" } }
          })
      }).capture(captureArgs)
    ).resolves.toEqual({ ok: false, requires_authentication: true, continue_url: "https://stripe.test/auth" });

    await expect(
      stripePsp({
        apiKey: "sk_test_unit",
        fetch: async () => stripeResponse({ error: { code: "card_declined", message: "declined" } }, 402)
      }).capture(captureArgs)
    ).resolves.toEqual({ ok: false, reason: "declined", message: "declined" });
    await expect(
      stripePsp({
        apiKey: "sk_test_unit",
        fetch: async () => stripeResponse({ error: { code: "expired_card", message: "expired" } }, 402)
      }).capture(captureArgs)
    ).resolves.toEqual({ ok: false, reason: "expired_card", message: "expired" });
    await expect(
      stripePsp({
        apiKey: "sk_test_unit",
        fetch: async () => stripeResponse({ error: { code: "insufficient_funds", message: "funds" } }, 402)
      }).capture(captureArgs)
    ).resolves.toEqual({ ok: false, reason: "insufficient_funds", message: "funds" });
    await expect(
      stripePsp({
        apiKey: "sk_test_unit",
        fetch: async () => stripeResponse({ error: { code: "other", message: "other" } }, 402)
      }).capture(captureArgs)
    ).resolves.toEqual({ ok: false, reason: "other", message: "other" });
  });

  it("redacts Stripe API keys from thrown errors and supports cancel idempotency", async () => {
    const secret = "sk_test_secret_123";
    const failing = stripePsp({
      apiKey: secret,
      fetch: async () => {
        throw new Error(`network failed for ${secret}`);
      }
    });

    try {
      await failing.capture(captureArgs);
      throw new Error("capture should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).stack ?? "").not.toContain(secret);
      expect((error as Error).message).toContain("[redacted]");
    }

    const calls: { url: string; init: RequestInit }[] = [];
    const psp = stripePsp({
      apiKey: secret,
      apiBaseUrl: "https://stripe.test/",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return stripeResponse({ id: "pi_1", status: "canceled" });
      }
    });
    await psp.cancel({ psp_payment_id: "pi_1", idempotencyKey: "cancel_1" });
    expect(calls[0]!.url).toBe("https://stripe.test/v1/payment_intents/pi_1/cancel");
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("cancel_1");
  });
});

function stripeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function issueReferenceToken(overrides: Partial<{
  merchant_id: string;
  checkout_id: string;
  transaction_id: string;
  amount: number;
  currency: string;
  handler_id: string;
  instrument_type: string;
  exp: number;
}> = {}): Promise<string> {
  const payload = {
    merchant_id: "merchant_1",
    checkout_id: "cs_1",
    transaction_id: "cs_1",
    amount: 500,
    currency: "USD",
    handler_id: "reference",
    instrument_type: REFERENCE_PAYMENT_INSTRUMENT_TYPE,
    exp: nowSeconds + 300,
    ...overrides
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const detached = await signDetachedJws({
    payload: payloadBytes,
    header: { alg: "ES256", kid: holderP256PublicKey.kid },
    privateKey: holderP256PrivateKey
  });
  const [header, empty, signature] = detached.split(".");
  if (!header || empty !== "" || !signature) throw new Error("bad detached reference token");
  return `${REFERENCE_PAYMENT_TOKEN_PREFIX}${header}.${payloadBytes.toString("base64url")}.${signature}`;
}

function referenceCaptureArgs(token: string, idempotencyKey = "idem_reference_valid"): PspCaptureArgs {
  return {
    ...captureArgs,
    vault_token: token,
    idempotencyKey,
    handler_id: "reference",
    instrument_type: REFERENCE_PAYMENT_INSTRUMENT_TYPE
  };
}

function alterReferenceToken(token: string, patch: Record<string, unknown>): string {
  const prefix = REFERENCE_PAYMENT_TOKEN_PREFIX;
  if (!token.startsWith(prefix)) throw new Error("expected reference token");
  const parts = token.slice(prefix.length).split(".");
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const nextPayload = Buffer.from(JSON.stringify({ ...payload, ...patch }), "utf8").toString("base64url");
  return `${prefix}${parts[0]}.${nextPayload}.${parts[2]}`;
}

async function issuePaymentMandate(opts: {
  handlerId?: string;
  paymentInstrument?: { id: string; type: string; description?: string };
} = {}): Promise<NonNullable<PspCaptureArgs["payment_mandate"]>> {
  const transaction_id = createHash("sha256").update("merchant-authorization-jws").digest("base64url");
  const expires_at = new Date(now.getTime() + 15 * 60_000).toISOString();
  const claims = {
    iss: "did:example:bank-dpc-issuer",
    iat: nowSeconds,
    exp: nowSeconds + 300,
    aud: "https://coffee.example/.well-known/ucp",
    cnf: { jwk: holderP256PublicKey },
    vct: "mandate.payment.1",
    transaction_id,
    payee: { id: "merchant_1", name: "Demo Merchant", website: "https://coffee.example" },
    ...(opts.handlerId ? { payment: { handler: opts.handlerId } } : {}),
    payment_amount: { amount: 500, currency: "USD" },
    payment_instrument: opts.paymentInstrument ?? { id: "card_1", type: "card", description: "Visa 4242" }
  };
  const sdJwt = new SDJwtInstance<typeof claims>({
    signer: signerFor(holderP256PrivateKey, "ES256"),
    signAlg: "ES256",
    kbSigner: signerFor(holderP256PrivateKey, "ES256"),
    kbSignAlg: "ES256",
    hasher: sha256Hasher,
    hashAlg: "sha-256",
    saltGenerator: saltSequence()
  });
  const issued = await sdJwt.issue(claims, {}, { header: { typ: "dc+sd-jwt", kid: holderP256PublicKey.kid } });
  const payload = await sdJwt.present(issued, {}, {
    kb: { payload: { iat: nowSeconds, aud: "https://coffee.example/.well-known/ucp", nonce: "payment_nonce_1" } }
  });
  return {
    format: "ap2-sd-jwt-kb",
    payload,
    holder_jwk: holderP256PublicKey,
    payment_intent: {
      amount: 500,
      currency: "USD",
      checkout_id: "checkout_123",
      expires_at,
      transaction_id
    }
  };
}

function signerFor(privateKey: EcJwk, algorithm: HmsAlgorithm) {
  return async (data: string): Promise<string> => {
    const signature = await ecdsaSignRaw({ algorithm, privateKeyJwk: privateKey, data: Buffer.from(data, "utf8") });
    return Buffer.from(signature).toString("base64url");
  };
}

async function sha256Hasher(data: string | ArrayBuffer, alg: string): Promise<Uint8Array> {
  if (alg !== "sha-256" && alg !== "sha256") throw new Error(`unsupported hash alg: ${alg}`);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(bytes).digest();
}

function saltSequence(): () => string {
  let index = 0;
  return () => `salt-${index++}`;
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const holderP256PublicKey = {
  kid: "holder-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const holderP256PrivateKey = {
  ...holderP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

async function withMockEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = [
    "VITEST",
    "JEST_WORKER_ID",
    "STEELYARD_TEST",
    "STEELYARD_ALLOW_MOCK_PSP",
    "STEELYARD_ALLOW_REFERENCE_PSP",
    "NODE_ENV"
  ] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
