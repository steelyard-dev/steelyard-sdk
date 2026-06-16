import { afterEach, describe, expect, it } from "vitest";
import { ACP_API_VERSION_HEADER, ACP_VERSION } from "@steelyard/protocol/acp";
import type { PspAdapter, PspCaptureArgs } from "@steelyard/merchant/psp";
import {
  startCoffeeShopCheckoutServer,
  type RunningCoffeeShopCheckout
} from "./checkout-server.js";

const bearerToken = "vanilla-acp-bearer";
let shop: RunningCoffeeShopCheckout | undefined;

afterEach(async () => {
  await shop?.close();
  shop = undefined;
});

describe("vanilla ACP buyer interop", () => {
  it("purchases from the Steelyard coffee-shop merchant over raw ACP REST", async () => {
    const captures: PspCaptureArgs[] = [];
    shop = await startCoffeeShopCheckoutServer({
      acpBearerToken: bearerToken,
      psp: stripeLikePsp(captures)
    });

    const discovery = await getJson(`${shop.baseUrl}/.well-known/acp.json`);
    expect(discovery.api_base_url).toBe(`${shop.baseUrl}/acp`);

    const created = await postAcp(`${shop.baseUrl}/acp/checkout_sessions`, {
      line_items: [{ id: "single", name: "Single Espresso", unit_amount: 300 }],
      currency: "USD",
      capabilities: {}
    }, "vanilla-acp-create");
    expect(created.status).toBe("ready_for_payment");
    const sessionId = String(created.id);
    expect(sessionId).toMatch(/^cs_/);

    const completed = await postAcp(`${shop.baseUrl}/acp/checkout_sessions/${encodeURIComponent(sessionId)}/complete`, {
      payment_data: {
        handler_id: "stripe",
        instrument: {
          type: "card",
          credential: { type: "spt", token: "spt_vanilla123" }
        }
      }
    }, "vanilla-acp-complete");

    expect(completed.status).toBe("completed");
    expect(record(completed.order).id).toBe(`order_${sessionId}`);
    expect(record(completed.payment_details)).toEqual({});
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      vault_token: "spt_vanilla123",
      handler_id: "stripe",
      amount: 300,
      currency: "USD"
    });
  });
});

function stripeLikePsp(captures: PspCaptureArgs[]): PspAdapter {
  return {
    name: "stripe",
    supportsHandler: (handlerId) => handlerId === "stripe",
    async capture(args) {
      captures.push(args);
      return {
        ok: true,
        psp_payment_id: "pi_vanilla123",
        psp_charge_id: "ch_vanilla123",
        psp_charge_status: "succeeded",
        status: "captured"
      };
    },
    async cancel() {
      return;
    }
  };
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  const body = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(200);
  return body;
}

async function postAcp(url: string, body: unknown, idempotencyKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ACP_API_VERSION_HEADER]: ACP_VERSION,
      authorization: `Bearer ${bearerToken}`,
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as Record<string, unknown>;
  expect(response.status).toBeLessThan(300);
  return payload;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
