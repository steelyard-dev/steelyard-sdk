// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import { SDJwtInstance } from "@sd-jwt/core";
import { ecdsaSignRaw, type EcJwk, type HmsAlgorithm } from "@steelyard/core";
import { describe, expect, it } from "vitest";
import {
  MockInProductionError,
  PspConfigError,
  StripeLiveDisabledError,
  mockPsp,
  mockVaultToken,
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
      expect(mockVaultToken({ paymentCredential: "pm_1", idempotencyKey: "idem_1", seed: "unit" })).toMatch(
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
      expect(() => mockVaultToken({ paymentCredential: "", idempotencyKey: "idem" })).toThrow(/paymentCredential/);
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

describe("stripePsp", () => {
  it("requires an explicit API key and handler match", () => {
    expect(() => stripePsp({ apiKey: "" })).toThrow(/apiKey/);
    expect(() => stripePsp({ apiKey: "sk_live_unit" })).toThrow(StripeLiveDisabledError);
    expect(() => stripePsp({ apiKey: "rk_test_unit", acceptSharedPaymentTokens: true })).toThrow(StripeLiveDisabledError);
    const psp = stripePsp({ apiKey: "sk_test_unit", fetch: async () => stripeResponse({ id: "pi_1", status: "succeeded" }) });
    expect(psp.name).toBe("stripe");
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

  it("uses an SPT embedded in a verified AP2 payment mandate (AP1, SC1)", async () => {
    const paymentMandate = await issuePaymentMandate({
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

    await expect(psp.capture({ ...captureArgs, payment_mandate: paymentMandate })).resolves.toMatchObject({
      ok: true,
      psp_payment_id: "pi_spt"
    });
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("payment_method_data[shared_payment_granted_token]")).toBe("spt_123");
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

async function issuePaymentMandate(opts: {
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
  const keys = ["VITEST", "JEST_WORKER_ID", "STEELYARD_TEST", "STEELYARD_ALLOW_MOCK_PSP", "NODE_ENV"] as const;
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
