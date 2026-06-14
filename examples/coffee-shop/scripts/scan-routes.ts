import { startCoffeeShopCheckoutServer } from "../src/checkout-server.js";

const REQUIRED_ENV = ["STEELYARD_ALLOW_MOCK_PSP", "STEELYARD_ALLOW_MOCK_MANDATE"];
const BLOCKED_PATHS = [
  "/agentic_commerce/delegate_payment",
  "/acp/agentic_commerce/delegate_payment",
  "/ucp/agentic_commerce/delegate_payment"
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
  const observed: Array<{ path: string; status: number }> = [];
  for (const path of BLOCKED_PATHS) {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    observed.push({ path, status: response.status });
    if (response.status !== 404) {
      throw new Error(`merchant unexpectedly served ${path} with HTTP ${response.status}`);
    }
  }
  console.log(JSON.stringify({ ok: true, checked: observed }, null, 2));
} finally {
  await server.close();
}
