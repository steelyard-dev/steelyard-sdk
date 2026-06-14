// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  MockInProductionError,
  PspConfigError,
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
});

describe("stripePsp", () => {
  it("requires an explicit API key and handler match", () => {
    expect(() => stripePsp({ apiKey: "" })).toThrow(/apiKey/);
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
