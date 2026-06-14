// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type RequestListener, type Server } from "node:http";
import { defineCommerce, type Decision, type PurchaseIntent } from "@steelyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMandateVerifier } from "../mandate/index.js";
import type { MerchantPolicy } from "../policy/index.js";
import type { PspAdapter, PspCaptureArgs, PspCaptureResult } from "../psp/index.js";
import {
  createMerchantCheckout,
  memoryCheckoutSessionStore,
  memoryIdempotencyStore,
  MerchantCheckoutConfigError
} from "./index.js";

const now = new Date("2026-06-14T12:00:00.000Z");
const manifest = defineCommerce({
  identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["usd"] },
  offers: [
    {
      id: "latte",
      title: "Latte",
      categories: ["coffee"],
      pricing: [{ kind: "one_time", amount: 500, currency: "usd" }]
    }
  ]
});

const acpCreateBody = {
  line_items: [{ id: "latte", name: "Latte", unit_amount: 500 }],
  currency: "USD",
  capabilities: {}
};
const ucpLineItems = [{ item: { id: "latte" }, quantity: 1 }];
const ucpPaymentHint = {
  instruments: [{ id: "instrument_1", handler_id: "stripe", type: "vault_token", selected: true }]
};
const ucpPaymentComplete = {
  instruments: [
    {
      id: "instrument_1",
      handler_id: "stripe",
      type: "vault_token",
      credential: { type: "vault_token", token: "vt_1" },
      selected: true
    }
  ]
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("createMerchantCheckout", () => {
  it("validates construction options and does not mount a delegate_payment proxy", async () => {
    const psp = recordingPsp();
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: [],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      })
    ).toThrow(MerchantCheckoutConfigError);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      })
    ).toThrow(/mandateVerifier/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["acp"],
        store: memoryCheckoutSessionStore(),
        psp: Object.assign(recordingPsp().adapter, { supportedCurrencies: ["EUR"] }),
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      })
    ).toThrow(/USD/);

    const app = createMerchantCheckout(manifest, {
      protocols: ["acp"],
      store: memoryCheckoutSessionStore(),
      psp: psp.adapter,
      idempotency: memoryIdempotencyStore(),
      clock: () => now
    });
    const client = await listen(app.handler);
    await expect(client.post("/agentic_commerce/delegate_payment", {}, "delegate")).resolves.toMatchObject({
      status: 404,
      body: { error: "not_found" }
    });
    await expect(client.post("/acp/checkout_sessions", acpCreateBody, undefined)).resolves.toMatchObject({
      status: 400,
      body: { error: "idempotency_key_required" }
    });
    await expect(client.raw("/acp/checkout_sessions", "not json", "bad-json")).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_json" }
    });
    await expect(client.get("/acp/checkout_sessions/missing")).resolves.toMatchObject({
      status: 404,
      body: { error: "not_found", id: "missing" }
    });
  });

  it("runs the ACP checkout routes with idempotent policy and PSP capture", async () => {
    const psp = recordingPsp();
    const policy = recordingPolicy();
    const app = createMerchantCheckout(manifest, {
      protocols: ["acp"],
      store: memoryCheckoutSessionStore(),
      psp: psp.adapter,
      policy: policy.instance,
      idempotency: memoryIdempotencyStore({ clock: () => now }),
      clock: () => now
    });
    const client = await listen(app.handler);

    const created = await client.post("/acp/checkout_sessions", acpCreateBody, "acp-create");
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      status: "ready_for_payment",
      capabilities: { payment: { handlers: [expect.objectContaining({ id: "stripe" })] } }
    });
    const replay = await client.post("/acp/checkout_sessions", acpCreateBody, "acp-create");
    expect(replay).toEqual(created);
    expect(policy.calls).toHaveLength(1);
    await expect(
      client.post("/acp/checkout_sessions", { ...acpCreateBody, currency: "EUR" }, "acp-create")
    ).resolves.toMatchObject({ status: 422, body: { error: "idempotency_conflict" } });

    const sessionId = stringField(created.body, "id");
    await expect(client.get(`/acp/checkout_sessions/${sessionId}`)).resolves.toMatchObject({
      status: 200,
      body: expect.objectContaining({ id: sessionId })
    });
    await expect(
      client.patch(`/acp/checkout_sessions/${sessionId}`, { selected_fulfillment_options: [] }, "acp-update")
    ).resolves.toMatchObject({
      status: 200,
      body: expect.objectContaining({ selected_fulfillment_options: [] })
    });
    await expect(client.post("/acp/discounts", { codes: ["SAVE20"] }, undefined)).resolves.toMatchObject({
      status: 200,
      body: { codes: ["SAVE20"], applied: [], rejected: [expect.objectContaining({ code: "SAVE20" })] }
    });

    const completeBody = acpCompleteBody("stripe", "vt_1");
    const completed = await client.post(`/acp/checkout_sessions/${sessionId}/complete`, completeBody, "acp-complete");
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: "completed",
      payment_details: { psp_payment_id: expect.stringMatching(/^pi_/) }
    });
    expect(psp.captures).toHaveLength(1);
    expect(psp.captures[0]!.idempotencyKey).toBe(`psp:acp:${sessionId}:capture`);

    const completeReplay = await client.post(
      `/acp/checkout_sessions/${sessionId}/complete`,
      completeBody,
      "acp-complete"
    );
    expect(completeReplay).toEqual(completed);
    expect(psp.captures).toHaveLength(1);
  });

  it("serializes ACP completion across idempotency and store CAS boundaries", async () => {
    const psp = recordingPsp({ delayMs: 25 });
    const client = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["acp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );

    const first = await client.post("/acp/checkout_sessions", acpCreateBody, "cas-create-1");
    const firstId = stringField(first.body, "id");
    const sameKey = await Promise.all([
      client.post(`/acp/checkout_sessions/${firstId}/complete`, acpCompleteBody("stripe", "vt_1"), "same-complete"),
      client.post(`/acp/checkout_sessions/${firstId}/complete`, acpCompleteBody("stripe", "vt_1"), "same-complete")
    ]);
    expect(sameKey[0]).toEqual(sameKey[1]);
    expect(sameKey[0]!.status).toBe(200);

    const second = await client.post("/acp/checkout_sessions", acpCreateBody, "cas-create-2");
    const secondId = stringField(second.body, "id");
    const raced = await Promise.all([
      client.post(`/acp/checkout_sessions/${secondId}/complete`, acpCompleteBody("stripe", "vt_2"), "complete-a"),
      client.post(`/acp/checkout_sessions/${secondId}/complete`, acpCompleteBody("stripe", "vt_2"), "complete-b")
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(raced.find((response) => response.status === 409)?.body).toMatchObject({ error: "store_cas_conflict" });
    expect(psp.captures.filter((capture) => capture.session_id === secondId)).toHaveLength(1);
  });

  it("cancels ACP sessions on handler and PSP failures", async () => {
    const handlerMismatch = recordingPsp({ handlerIds: ["stripe"] });
    const mismatchClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["acp"],
        store: memoryCheckoutSessionStore(),
        psp: handlerMismatch.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );
    const mismatch = await mismatchClient.post("/acp/checkout_sessions", acpCreateBody, "mismatch-create");
    const mismatchId = stringField(mismatch.body, "id");
    await expect(
      mismatchClient.post(`/acp/checkout_sessions/${mismatchId}/complete`, acpCompleteBody("other", "vt_1"), "mismatch")
    ).resolves.toMatchObject({
      status: 400,
      body: { status: "canceled", messages: { errors: [expect.objectContaining({ code: "payment_handler_mismatch" })] } }
    });
    expect(handlerMismatch.captures).toHaveLength(0);

    const declined = recordingPsp({ result: { ok: false, reason: "declined", message: "declined" } });
    const declinedClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["acp"],
        store: memoryCheckoutSessionStore(),
        psp: declined.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );
    const created = await declinedClient.post("/acp/checkout_sessions", acpCreateBody, "declined-create");
    const id = stringField(created.body, "id");
    await expect(
      declinedClient.post(`/acp/checkout_sessions/${id}/complete`, acpCompleteBody("stripe", "vt_1"), "declined")
    ).resolves.toMatchObject({
      status: 402,
      body: { status: "canceled", messages: { errors: [expect.objectContaining({ code: "payment_declined" })] } }
    });

    const cancelClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["acp"],
        store: memoryCheckoutSessionStore(),
        psp: recordingPsp().adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );
    const cancelCreated = await cancelClient.post("/acp/checkout_sessions", acpCreateBody, "cancel-create");
    const cancelId = stringField(cancelCreated.body, "id");
    await expect(cancelClient.post(`/acp/checkout_sessions/${cancelId}/cancel`, {}, "cancel")).resolves.toMatchObject({
      status: 200,
      body: { status: "canceled" }
    });
  });

  it("runs UCP checkout with mandate verification and maps mandate failures", async () => {
    const psp = recordingPsp();
    const okClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        mandateVerifier: mockMandateVerifier({ alwaysOk: { subject_id: "buyer_1", key_id: "key_1" } }),
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        merchantAudience: "https://coffee.example/.well-known/ucp"
      }).handler
    );

    const created = await okClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-create");
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      status: "ready_for_complete",
      ucp: { payment_handlers: { "net.steelyard": [expect.objectContaining({ id: "stripe" })] } }
    });
    const checkoutId = stringField(created.body, "id");
    await expect(
      okClient.patch(
        `/ucp/api/checkout/${checkoutId}`,
        { line_items: ucpLineItems, payment: ucpPaymentHint },
        "ucp-update"
      )
    ).resolves.toMatchObject({ status: 200, body: expect.objectContaining({ payment: ucpPaymentHint }) });
    await expect(okClient.get(`/ucp/api/checkout/${checkoutId}`)).resolves.toMatchObject({
      status: 200,
      body: expect.objectContaining({ id: checkoutId })
    });
    const completed = await okClient.post(
      `/ucp/api/checkout/${checkoutId}/complete`,
      { payment: ucpPaymentComplete, "steelyard.checkout_mandate": "mock.jwt" },
      "ucp-complete"
    );
    expect(completed).toMatchObject({
      status: 200,
      body: { status: "completed", order: { id: `order_${checkoutId}`, permalink_url: expect.any(String) } }
    });
    expect(completed.body.order).not.toHaveProperty("status");
    expect(psp.captures[0]).toMatchObject({ handler_id: "stripe", idempotencyKey: `psp:ucp:${checkoutId}:capture` });

    const failingPsp = recordingPsp();
    const failClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: failingPsp.adapter,
        mandateVerifier: mockMandateVerifier({ alwaysReason: "audience_mismatch" }),
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );
    const failCreated = await failClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-fail-create");
    const failId = stringField(failCreated.body, "id");
    await expect(
      failClient.post(
        `/ucp/api/checkout/${failId}/complete`,
        { payment: ucpPaymentComplete, "steelyard.checkout_mandate": "mock.jwt" },
        "ucp-fail-complete"
      )
    ).resolves.toMatchObject({
      status: 400,
      body: {
        status: "canceled",
        messages: { errors: [expect.objectContaining({ code: "mandate_audience_mismatch" })] }
      }
    });
    expect(failingPsp.captures).toHaveLength(0);
  });

  it("maps policy denials before route side effects", async () => {
    const psp = recordingPsp();
    const policy = recordingPolicy({ status: "denied", reason: "blocked" });
    const client = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["acp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        policy: policy.instance,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );

    await expect(client.post("/acp/checkout_sessions", acpCreateBody, "policy-deny")).resolves.toMatchObject({
      status: 403,
      body: { error: "policy_denied", reason: "blocked" }
    });
    expect(policy.calls[0]).toMatchObject({ amount: 500, currency: "USD" });
    expect(psp.captures).toHaveLength(0);
  });
});

function acpCompleteBody(handlerId: string, token: string): Record<string, unknown> {
  return {
    payment_data: {
      handler_id: handlerId,
      instrument: {
        type: "vault_token",
        credential: { type: "vault_token", token }
      }
    }
  };
}

function recordingPsp(opts: {
  result?: PspCaptureResult;
  delayMs?: number;
  handlerIds?: readonly string[];
} = {}): { adapter: PspAdapter; captures: PspCaptureArgs[] } {
  const captures: PspCaptureArgs[] = [];
  const handlerIds = new Set(opts.handlerIds ?? ["stripe"]);
  return {
    captures,
    adapter: {
      name: "stripe",
      supportsHandler: (handlerId) => handlerIds.has(handlerId),
      async capture(args) {
        captures.push({ ...args, metadata: { ...args.metadata } });
        if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        return opts.result ?? { ok: true, psp_payment_id: `pi_${captures.length}`, status: "captured" };
      },
      async cancel() {
        return undefined;
      }
    }
  };
}

function recordingPolicy(decision: Decision = { status: "allowed", rule: "allow" }): {
  instance: MerchantPolicy;
  calls: PurchaseIntent[];
} {
  const calls: PurchaseIntent[] = [];
  return {
    calls,
    instance: {
      evaluate: vi.fn(async (intent: PurchaseIntent) => {
        calls.push(intent);
        return decision;
      })
    } as unknown as MerchantPolicy
  };
}

async function listen(handler: RequestListener): Promise<TestClient> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    get: (path) => request(baseUrl, path, { method: "GET" }),
    post: (path, body, key) => request(baseUrl, path, { method: "POST", body, key }),
    patch: (path, body, key) => request(baseUrl, path, { method: "PATCH", body, key }),
    raw: (path, raw, key) => request(baseUrl, path, { method: "POST", raw, key })
  };
}

interface TestClient {
  get(path: string): Promise<TestResponse>;
  post(path: string, body: unknown, key?: string): Promise<TestResponse>;
  patch(path: string, body: unknown, key?: string): Promise<TestResponse>;
  raw(path: string, raw: string, key?: string): Promise<TestResponse>;
}

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  baseUrl: string,
  path: string,
  opts: { method: string; body?: unknown; raw?: string; key?: string }
): Promise<TestResponse> {
  const headers: Record<string, string> = {};
  if (opts.key) headers["idempotency-key"] = opts.key;
  if (opts.body !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: opts.method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function stringField(value: unknown, key: string): string {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  if (typeof field !== "string") throw new Error(`expected ${key} to be a string`);
  return field;
}
