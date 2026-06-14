import { startCoffeeShopCheckoutServer } from "../src/checkout-server.js";

const REQUIRED_ENV = ["STEELYARD_ALLOW_MOCK_PSP", "STEELYARD_ALLOW_MOCK_MANDATE"];
const BLOCKED_DELEGATE_PATHS = [
  "/agentic_commerce/delegate_payment",
  "/acp/agentic_commerce/delegate_payment",
  "/ucp/agentic_commerce/delegate_payment"
];
const BLOCKED_COMMERCE_MUTATIONS = [
  { method: "POST", path: "/commerce" },
  { method: "POST", path: "/commerce/products" },
  { method: "PUT", path: "/commerce/products?id=single" },
  { method: "DELETE", path: "/commerce/products?id=single" },
  { method: "PATCH", path: "/commerce/policies" },
  { method: "POST", path: "/commerce/orders" },
  { method: "POST", path: "/commerce/checkout" }
];

for (const key of REQUIRED_ENV) {
  if (process.env[key] !== "1") {
    throw new Error(`${key}=1 is required to run the route scanner with demo mocks`);
  }
}

const server = await startCoffeeShopCheckoutServer({
  clock: () => new Date("2026-06-14T12:00:00.000Z")
});

try {
  const observed: Array<{ method: string; path: string; status: number }> = [];
  for (const path of BLOCKED_DELEGATE_PATHS) {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    observed.push({ method: "POST", path, status: response.status });
    if (response.status !== 404) {
      throw new Error(`merchant unexpectedly served ${path} with HTTP ${response.status}`);
    }
  }
  for (const check of BLOCKED_COMMERCE_MUTATIONS) {
    const response = await fetch(`${server.baseUrl}${check.path}`, {
      method: check.method,
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    observed.push({ ...check, status: response.status });
    if (![404, 405].includes(response.status)) {
      throw new Error(`commerce mutation route unexpectedly served ${check.method} ${check.path} with HTTP ${response.status}`);
    }
  }
  console.log(JSON.stringify({ ok: true, checked: observed }, null, 2));
} finally {
  await server.close();
}
