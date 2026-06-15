// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type RequestListener, type Server } from "node:http";
import {
  defineCommerce,
  jcsCanonicalize,
  verifyDetachedJws,
  type Decision,
  type EcJwk,
  type PurchaseIntent
} from "@steelyard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ap2MerchantAuthorizationSigner, checkoutWithoutAp2, mockMandateVerifier } from "../mandate/index.js";
import type { MerchantPolicy } from "../policy/index.js";
import type { PspAdapter, PspCaptureArgs, PspCaptureResult } from "../psp/index.js";
import {
  createMerchantCheckout,
  memoryCheckoutSessionStore,
  memoryIdempotencyStore,
  MerchantCheckoutConfigError
} from "./index.js";
import { signUcpRequest, UCP_AP2_CAPABILITY, verifyUcpResponse } from "@steelyard/protocol/ucp";

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

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const merchantP256PublicKey = {
  kid: "merchant-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const merchantP256PrivateKey = {
  ...merchantP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

const walletP256PublicKey = {
  ...merchantP256PublicKey,
  kid: "wallet-p256"
} satisfies EcJwk;

const walletP256PrivateKey = {
  ...walletP256PublicKey,
  d: merchantP256PrivateKey.d
} satisfies EcJwk;

const merchantP384PrivateKey = {
  kid: "merchant-p384",
  kty: "EC",
  crv: "P-384",
  x: b64urlHex(
    "EC3A4E415B4E19A4568618029F427FA5DA9A8BC4AE92E02E06AAE5286B300C64" +
      "DEF8F0EA9055866064A254515480BC13"
  ),
  y: b64urlHex(
    "8015D9B72D7D57244EA8EF9AC0C621896708A59367F9DFB9F54CA84B3F1C9DB1" +
      "288B231C3AE0D4FE7344FD2533264720"
  ),
  d: b64urlHex("6B9D3DAD2E1B8C1C05B19875B6659F4DE23C3B667BF297BA9AA47740787137D8" + "96D5724E4C70A825F872C9EA60D2EDF5"),
  use: "sig",
  alg: "ES384"
} satisfies EcJwk;

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
    ).not.toThrow();
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        steelyardMandate: true,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      })
    ).toThrow(/mandateVerifier/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        ucp: { auth: { hms: { enabled: false, signingKeys: [], activeKid: "" } } },
        clock: () => now
      })
    ).not.toThrow();
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        ucp: { auth: { hms: { enabled: true, signingKeys: [], activeKid: "merchant-p256" } } },
        clock: () => now
      })
    ).toThrow(/signingKeys/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" }],
              activeKid: "missing"
            }
          }
        },
        clock: () => now
      })
    ).toThrow(/activeKid/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES384" }],
              activeKid: "merchant-p256"
            }
          }
        },
        clock: () => now
      })
    ).toThrow(/ES256/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PublicKey, algorithm: "ES256" }],
              activeKid: "merchant-p256"
            }
          }
        },
        clock: () => now
      })
    ).toThrow(/private d/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys: [
                { kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" },
                { kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" }
              ],
              activeKid: "merchant-p256"
            }
          }
        },
        clock: () => now
      })
    ).toThrow(/duplicate/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys: [
                { kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" },
                { kid: "merchant-p384", privateKeyJwk: merchantP384PrivateKey, algorithm: "ES384" }
              ],
              activeKid: "merchant-p384"
            }
          }
        },
        clock: () => now
      })
    ).not.toThrow();
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

  it("requires AP2 merchant authorization config when AP2 is enabled", () => {
    const psp = recordingPsp();
    const signingKeys = [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" as const }];
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          ap2: { enabled: true }
        }
      })
    ).toThrow(/signingKeys/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys,
              activeKid: "merchant-p256"
            }
          },
          ap2: { enabled: true }
        }
      })
    ).toThrow(/merchantAuthorizationSigner/);
    expect(() =>
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys,
              activeKid: "merchant-p256"
            }
          },
          ap2: {
            enabled: true,
            merchantAuthorizationSigner: ap2MerchantAuthorizationSigner({ signingKeys, activeKid: "merchant-p256" })
          }
        }
      })
    ).not.toThrow();
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
      order: expect.objectContaining({ id: expect.stringMatching(/^order_/) })
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
    const baseVerifier = mockMandateVerifier({ alwaysOk: { subject_id: "buyer_1", key_id: "key_1" } });
    const okClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        mandateVerifier: {
          async verify(envelope, checkout, audience) {
            if (typeof envelope["steelyard.checkout_mandate"] !== "string") return { ok: false, reason: "missing_mandate" };
            return baseVerifier.verify(envelope, checkout, audience);
          }
        },
        steelyardMandate: true,
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

    const missingCreated = await okClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-missing-create");
    const missingId = stringField(missingCreated.body, "id");
    await expect(
      okClient.post(
        `/ucp/api/checkout/${missingId}/complete`,
        { payment: ucpPaymentComplete },
        "ucp-missing-complete"
      )
    ).resolves.toMatchObject({
      status: 400,
      body: {
        status: "canceled",
        messages: { errors: [expect.objectContaining({ code: "mandate_required" })] }
      }
    });
    expect(psp.captures).toHaveLength(1);

    const failingPsp = recordingPsp();
    const failClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: failingPsp.adapter,
        mandateVerifier: mockMandateVerifier({ alwaysReason: "audience_mismatch" }),
        steelyardMandate: true,
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

    const invalidPsp = recordingPsp();
    const invalidClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: invalidPsp.adapter,
        mandateVerifier: mockMandateVerifier({ alwaysReason: "bad_signature" }),
        steelyardMandate: true,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );
    const invalidCreated = await invalidClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-invalid-create");
    const invalidId = stringField(invalidCreated.body, "id");
    await expect(
      invalidClient.post(
        `/ucp/api/checkout/${invalidId}/complete`,
        { payment: ucpPaymentComplete, "steelyard.checkout_mandate": "mock.jwt" },
        "ucp-invalid-complete"
      )
    ).resolves.toMatchObject({
      status: 400,
      body: {
        status: "canceled",
        messages: { errors: [expect.objectContaining({ code: "mandate_invalid" })] }
      }
    });
    expect(invalidPsp.captures).toHaveLength(0);
  });

  it("runs vanilla UCP checkout without mandate verification", async () => {
    const psp = recordingPsp();
    const client = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );

    const created = await client.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-vanilla-create");
    const checkoutId = stringField(created.body, "id");
    const completed = await client.post(
      `/ucp/api/checkout/${checkoutId}/complete`,
      { payment: ucpPaymentComplete },
      "ucp-vanilla-complete"
    );

    expect(completed).toMatchObject({
      status: 200,
      body: { status: "completed", order: { id: `order_${checkoutId}` } }
    });
    expect(psp.captures).toHaveLength(1);

    const extraCreated = await client.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-extra-create");
    const extraId = stringField(extraCreated.body, "id");
    await expect(
      client.post(
        `/ucp/api/checkout/${extraId}/complete`,
        { payment: ucpPaymentComplete, "steelyard.checkout_mandate": "ignored.jwt" },
        "ucp-extra-complete"
      )
    ).resolves.toMatchObject({
      status: 200,
      body: { status: "completed", order: { id: `order_${extraId}` } }
    });
    expect(psp.captures).toHaveLength(2);
  });

  it("verifies signed UCP requests before policy and prefers HMS over bearer", async () => {
    const buyerProfileUrl = await startBuyerProfile([walletP256PublicKey]);
    const psp = recordingPsp();
    const policy = recordingPolicy();
    const bearerVerify = vi.fn(async () => ({ ok: true, subject: "bearer-subject" as const }));
    const client = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: psp.adapter,
        policy: policy.instance,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          allowPrivateNetwork: true,
          auth: {
            hms: {
              enabled: true,
              signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" }],
              activeKid: "merchant-p256"
            },
            bearer: { enabled: true, verify: bearerVerify }
          }
        }
      }).handler
    );

    const createBody = { line_items: ucpLineItems };
    const hmsHeaders = await signedUcpHeaders(client, "POST", "/ucp/api/checkout", createBody, "ucp-hms-create", buyerProfileUrl);
    hmsHeaders.authorization = "Bearer ignored";
    await expect(client.post("/ucp/api/checkout", createBody, "ucp-hms-create", hmsHeaders)).resolves.toMatchObject({
      status: 200,
      body: expect.objectContaining({ status: "ready_for_complete" })
    });
    expect(bearerVerify).not.toHaveBeenCalled();
    expect(policy.calls).toHaveLength(1);

    const tamperedHeaders = await signedUcpHeaders(
      client,
      "POST",
      "/ucp/api/checkout",
      createBody,
      "ucp-hms-tampered",
      buyerProfileUrl
    );
    await expect(
      client.post("/ucp/api/checkout", { line_items: [{ item: { id: "latte" }, quantity: 2 }] }, "ucp-hms-tampered", tamperedHeaders)
    ).resolves.toMatchObject({
      status: 400,
      body: { code: "digest_mismatch", content: expect.stringContaining("digest_mismatch") }
    });

    const unknownKid = await client.post(
      "/ucp/api/checkout",
      createBody,
      "ucp-hms-unknown-kid",
      await signedUcpHeaders(client, "POST", "/ucp/api/checkout", createBody, "ucp-hms-unknown-kid", buyerProfileUrl, "wallet-missing")
    );
    expect(unknownKid).toMatchObject({
      status: 401,
      body: { code: "key_not_found", content: expect.stringContaining("key_not_found") }
    });
    expect(String(unknownKid.body.content)).not.toContain("ucp-hms-unknown-kid");
    expect(policy.calls).toHaveLength(1);
    expect(psp.captures).toHaveLength(0);
  });

  it("signs high-value UCP complete responses when HMS is enabled", async () => {
    const buyerProfileUrl = await startBuyerProfile([walletP256PublicKey]);
    const client = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: recordingPsp().adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          allowPrivateNetwork: true,
          auth: {
            hms: {
              enabled: true,
              signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" }],
              activeKid: "merchant-p256"
            }
          }
        }
      }).handler
    );

    const createBody = { line_items: ucpLineItems };
    const created = await client.post(
      "/ucp/api/checkout",
      createBody,
      "ucp-hms-response-create",
      await signedUcpHeaders(client, "POST", "/ucp/api/checkout", createBody, "ucp-hms-response-create", buyerProfileUrl)
    );
    const checkoutId = stringField(created.body, "id");
    const completeBody = { payment: ucpPaymentComplete };
    const completed = await client.post(
      `/ucp/api/checkout/${checkoutId}/complete`,
      completeBody,
      "ucp-hms-response-complete",
      await signedUcpHeaders(
        client,
        "POST",
        `/ucp/api/checkout/${checkoutId}/complete`,
        completeBody,
        "ucp-hms-response-complete",
        buyerProfileUrl
      )
    );

    expect(completed).toMatchObject({ status: 200, body: { status: "completed" } });
    expect(completed.headers["signature-input"]).toContain("\"@status\"");
    expect(completed.headers.signature).toContain("sig1=:");
    expect(completed.headers["content-digest"]).toBeTruthy();
    await expect(
      verifyUcpResponse({
        status: completed.status,
        headers: completed.headers,
        body: Buffer.from(completed.rawBody, "utf8"),
        resolveKey: async (kid) => (kid === "merchant-p256" ? merchantP256PublicKey : null),
        now
      })
    ).resolves.toMatchObject({ ok: true, kid: "merchant-p256", algorithm: "ES256" });
  });

  it("mounts AP2 merchant authorization on AP2-locked UCP checkout responses", async () => {
    const signingKeys = [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" as const }];
    const store = memoryCheckoutSessionStore();
    const buyerProfileUrl = await startBuyerProfile([walletP256PublicKey], { ap2: true });
    const client = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store,
        psp: recordingPsp().adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          allowPrivateNetwork: true,
          auth: {
            hms: {
              enabled: true,
              signingKeys,
              activeKid: "merchant-p256"
            }
          },
          ap2: {
            enabled: true,
            merchantAuthorizationSigner: ap2MerchantAuthorizationSigner({ signingKeys, activeKid: "merchant-p256" })
          }
        }
      }).handler
    );

    const createBody = { line_items: ucpLineItems };
    const created = await client.post(
      "/ucp/api/checkout",
      createBody,
      "ucp-ap2-create",
      await signedUcpHeaders(client, "POST", "/ucp/api/checkout", createBody, "ucp-ap2-create", buyerProfileUrl)
    );
    expect(created.status).toBe(200);
    const checkoutId = stringField(created.body, "id");
    const stored = await store.get(checkoutId);
    if (!stored) throw new Error("expected created checkout to be stored");
    expect(stored).toMatchObject({ ap2_locked: true });
    expect(stored).not.toHaveProperty("ap2");

    const createdAp2 = recordField(created.body, "ap2");
    expect(stringField(createdAp2, "merchant_authorization")).toMatch(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);

    const fetched = await client.get(`/ucp/api/checkout/${checkoutId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).not.toHaveProperty("ap2_locked");
    const ap2 = recordField(fetched.body, "ap2");
    const merchantAuthorization = stringField(ap2, "merchant_authorization");
    expect(merchantAuthorization).toMatch(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);
    await expect(
      verifyDetachedJws({
        jws: merchantAuthorization,
        payload: jcsCanonicalize(checkoutWithoutAp2(fetched.body)),
        resolveKey: async (kid, alg) => (kid === "merchant-p256" && alg === "ES256" ? merchantP256PublicKey : null)
      })
    ).resolves.toMatchObject({ ok: true, kid: "merchant-p256", alg: "ES256" });
    await expect(
      verifyDetachedJws({
        jws: merchantAuthorization,
        payload: jcsCanonicalize(fetched.body),
        resolveKey: async (kid, alg) => (kid === "merchant-p256" && alg === "ES256" ? merchantP256PublicKey : null)
      })
    ).resolves.toMatchObject({ ok: false, reason: "signature_invalid" });

    const storedAfterFetch = await store.get(checkoutId);
    expect(storedAfterFetch).toMatchObject({ ap2_locked: true });
    expect(storedAfterFetch).not.toHaveProperty("ap2");

    const missingMandateBody = { payment: ucpPaymentComplete };
    const missingMandate = await client.post(
      `/ucp/api/checkout/${checkoutId}/complete`,
      missingMandateBody,
      "ucp-ap2-complete-missing",
      await signedUcpHeaders(
        client,
        "POST",
        `/ucp/api/checkout/${checkoutId}/complete`,
        missingMandateBody,
        "ucp-ap2-complete-missing",
        buyerProfileUrl
      )
    );
    expect(missingMandate).toMatchObject({
      status: 400,
      body: { code: "mandate_required", content: expect.stringContaining("checkout_mandate") }
    });
  });

  it("does not AP2-lock a UCP checkout when the buyer profile lacks AP2 capability", async () => {
    const signingKeys = [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" as const }];
    const store = memoryCheckoutSessionStore();
    const buyerProfileUrl = await startBuyerProfile([walletP256PublicKey]);
    const client = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store,
        psp: recordingPsp().adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          allowPrivateNetwork: true,
          auth: {
            hms: {
              enabled: true,
              signingKeys,
              activeKid: "merchant-p256"
            }
          },
          ap2: {
            enabled: true,
            merchantAuthorizationSigner: ap2MerchantAuthorizationSigner({ signingKeys, activeKid: "merchant-p256" })
          }
        }
      }).handler
    );

    const createBody = { line_items: ucpLineItems };
    const created = await client.post(
      "/ucp/api/checkout",
      createBody,
      "ucp-non-ap2-create",
      await signedUcpHeaders(client, "POST", "/ucp/api/checkout", createBody, "ucp-non-ap2-create", buyerProfileUrl)
    );
    expect(created.status).toBe(200);
    expect(created.body).not.toHaveProperty("ap2");
    const checkoutId = stringField(created.body, "id");
    await expect(store.get(checkoutId)).resolves.not.toMatchObject({ ap2_locked: true });

    const completeBody = { payment: ucpPaymentComplete };
    const completed = await client.post(
      `/ucp/api/checkout/${checkoutId}/complete`,
      completeBody,
      "ucp-non-ap2-complete",
      await signedUcpHeaders(
        client,
        "POST",
        `/ucp/api/checkout/${checkoutId}/complete`,
        completeBody,
        "ucp-non-ap2-complete",
        buyerProfileUrl
      )
    );
    expect(completed).toMatchObject({ status: 200, body: { status: "completed" } });
  });

  it("dispatches UCP bearer auth and rejects missing or unsupported auth methods", async () => {
    const bearerVerify = vi.fn(async (token: string) =>
      token === "good" ? { ok: true, subject: "buyer_1" } : { ok: false, reason: "bad token" }
    );
    const bearerClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: recordingPsp().adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: { auth: { bearer: { enabled: true, verify: bearerVerify } } }
      }).handler
    );

    await expect(
      bearerClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-bearer-create", {
        authorization: "Bearer good"
      })
    ).resolves.toMatchObject({ status: 200 });
    expect(bearerVerify).toHaveBeenCalledWith("good");

    await expect(
      bearerClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-missing-auth")
    ).resolves.toMatchObject({
      status: 401,
      body: { code: "auth_missing", content: expect.stringContaining("requires") }
    });

    await expect(
      bearerClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-bad-bearer", {
        authorization: "Bearer bad"
      })
    ).resolves.toMatchObject({
      status: 401,
      body: { code: "auth_invalid", content: "bad token" }
    });

    const buyerProfileUrl = await startBuyerProfile([walletP256PublicKey]);
    const hmsHeaders = await signedUcpHeaders(
      bearerClient,
      "POST",
      "/ucp/api/checkout",
      { line_items: ucpLineItems },
      "ucp-hms-disabled",
      buyerProfileUrl
    );
    await expect(
      bearerClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-hms-disabled", hmsHeaders)
    ).resolves.toMatchObject({
      status: 401,
      body: { code: "auth_method_not_supported", content: expect.stringContaining("Signatures") }
    });

    const hmsOnlyClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: recordingPsp().adapter,
        idempotency: memoryIdempotencyStore(),
        clock: () => now,
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" }],
              activeKid: "merchant-p256"
            }
          }
        }
      }).handler
    );
    await expect(
      hmsOnlyClient.post("/ucp/api/checkout", { line_items: ucpLineItems }, "ucp-bearer-disabled", {
        authorization: "Bearer good"
      })
    ).resolves.toMatchObject({
      status: 401,
      body: { code: "auth_method_not_supported", content: expect.stringContaining("bearer") }
    });
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

  it("maps validation and internal server errors to stable HTTP responses", async () => {
    const validationPolicy = recordingPolicy();
    const validationClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["ucp"],
        store: memoryCheckoutSessionStore(),
        psp: recordingPsp().adapter,
        policy: validationPolicy.instance,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );
    await expect(
      validationClient.post(
        "/ucp/api/checkout",
        {
          line_items: [
            {
              item: { id: "latte", title: "Latte", price: 500 },
              quantity: 1,
              totals: [{ type: "subtotal", display_text: "Subtotal", amount: 500 }]
            }
          ]
        },
        "ucp-validation-error"
      )
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "bad_request", message: expect.stringContaining("failed spec validation") }
    });
    expect(validationPolicy.calls[0]).toMatchObject({ amount: 0, currency: "USD" });

    const crashingPolicy = {
      evaluate: vi.fn(async () => {
        throw new Error("policy exploded");
      })
    } as unknown as MerchantPolicy;
    const crashClient = await listen(
      createMerchantCheckout(manifest, {
        protocols: ["acp"],
        store: memoryCheckoutSessionStore(),
        psp: recordingPsp().adapter,
        policy: crashingPolicy,
        idempotency: memoryIdempotencyStore(),
        clock: () => now
      }).handler
    );
    await expect(crashClient.post("/acp/checkout_sessions", acpCreateBody, "policy-crash")).resolves.toMatchObject({
      status: 500,
      body: { error: "internal_error", message: "policy exploded" }
    });
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
    baseUrl,
    get: (path, headers) => request(baseUrl, path, { method: "GET", headers }),
    post: (path, body, key, headers) => request(baseUrl, path, { method: "POST", body, key, headers }),
    patch: (path, body, key, headers) => request(baseUrl, path, { method: "PATCH", body, key, headers }),
    raw: (path, raw, key, headers) => request(baseUrl, path, { method: "POST", raw, key, headers })
  };
}

interface TestClient {
  baseUrl: string;
  get(path: string, headers?: Record<string, string>): Promise<TestResponse>;
  post(path: string, body: unknown, key?: string, headers?: Record<string, string>): Promise<TestResponse>;
  patch(path: string, body: unknown, key?: string, headers?: Record<string, string>): Promise<TestResponse>;
  raw(path: string, raw: string, key?: string, headers?: Record<string, string>): Promise<TestResponse>;
}

interface TestResponse {
  status: number;
  headers: Record<string, string>;
  rawBody: string;
  body: Record<string, unknown>;
}

async function request(
  baseUrl: string,
  path: string,
  opts: { method: string; body?: unknown; raw?: string; key?: string; headers?: Record<string, string> }
): Promise<TestResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers["idempotency-key"] = opts.key;
  if (opts.body !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: opts.method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    rawBody: text,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {}
  };
}

async function startBuyerProfile(signingKeys: EcJwk[], opts: { ap2?: boolean } = {}): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ucp: {
        version: "2026-04-17",
        ...(opts.ap2
          ? {
              capabilities: {
                [UCP_AP2_CAPABILITY]: [
                  {
                    version: "2026-04-17",
                    spec: "https://ucp.dev/2026-04-17/specification/ap2-mandates",
                    schema: "https://ucp.dev/2026-04-17/schemas/shopping/ap2_mandate.json",
                    extends: "dev.ucp.shopping.checkout",
                    config: {
                      vp_formats_supported: {
                        "dc+sd-jwt": {}
                      }
                    }
                  }
                ]
              }
            }
          : {})
      },
      signing_keys: signingKeys
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}/.well-known/ucp`;
}

async function signedUcpHeaders(
  client: TestClient,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  idempotencyKey: string,
  profileUrl: string,
  kid = "wallet-p256"
): Promise<Record<string, string>> {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  return (await signUcpRequest({
    method,
    url: new URL(`${client.baseUrl}${path}`),
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: rawBody,
    signing: { kid, algorithm: "ES256", privateKey: walletP256PrivateKey },
    ucpAgent: `profile="${profileUrl}"`,
    now
  })).headers;
}

function stringField(value: unknown, key: string): string {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  if (typeof field !== "string") throw new Error(`expected ${key} to be a string`);
  return field;
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error(`expected ${key} to be an object`);
  return field as Record<string, unknown>;
}
