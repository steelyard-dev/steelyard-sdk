import { startCoffeeShopCheckoutServer } from "../src/checkout-server.js";

if (process.env.STEELYARD_ALLOW_MOCK_PSP !== "1") {
  throw new Error("STEELYARD_ALLOW_MOCK_PSP=1 is required to run the vanilla UCP smoke");
}

const server = await startCoffeeShopCheckoutServer({
  clock: () => new Date("2026-06-14T12:00:00.000Z"),
  steelyardMandate: false,
  ucpAuthMode: "none"
});

try {
  const discovery = await json(`${server.baseUrl}/.well-known/ucp`);
  if (hasSteelyardMandate(discovery)) {
    throw new Error("vanilla UCP smoke server unexpectedly advertised Steelyard mandate mode");
  }

  const created = await json(`${server.baseUrl}/api/checkout`, {
    method: "POST",
    headers: jsonHeaders("vanilla-create"),
    body: JSON.stringify({ line_items: [{ item: { id: "cappuccino" }, quantity: 1 }] })
  });
  const checkoutId = stringField(created, "id");

  const updated = await json(`${server.baseUrl}/api/checkout/${encodeURIComponent(checkoutId)}`, {
    method: "PATCH",
    headers: jsonHeaders("vanilla-update"),
    body: JSON.stringify({
      line_items: [{ item: { id: "cappuccino" }, quantity: 1 }],
      payment: {
        instruments: [{ id: "instrument_1", handler_id: "stripe", type: "vault_token", selected: true }]
      }
    })
  });
  if (stringField(updated, "status") !== "ready_for_complete") {
    throw new Error(`checkout was not ready_for_complete: ${stringField(updated, "status")}`);
  }

  const completed = await json(`${server.baseUrl}/api/checkout/${encodeURIComponent(checkoutId)}/complete`, {
    method: "POST",
    headers: jsonHeaders("vanilla-complete"),
    body: JSON.stringify({
      payment: {
        instruments: [
          {
            id: "instrument_1",
            handler_id: "stripe",
            type: "vault_token",
            credential: { type: "vault_token", token: "vt_vanilla" },
            selected: true
          }
        ]
      }
    })
  });

  if (stringField(completed, "status") !== "completed") {
    throw new Error(`vanilla UCP complete failed: ${JSON.stringify(completed)}`);
  }

  console.log(JSON.stringify({ ok: true, checkout_id: checkoutId, status: completed.status }, null, 2));
} finally {
  await server.close();
}

async function json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function jsonHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`missing string field ${key}`);
  return field;
}

function hasSteelyardMandate(value: Record<string, unknown>): boolean {
  const ucp = record(value.ucp);
  const capabilities = record(ucp.capabilities);
  return Array.isArray(capabilities["net.steelyard.checkout_mandate.v0_1"]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
