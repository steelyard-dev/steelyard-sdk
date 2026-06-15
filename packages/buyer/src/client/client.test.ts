import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildAcpFeed } from "@steelyard/protocol/acp";
import { defineCommerce, type PurchaseIntent, type WalletDriverPort } from "@steelyard/core";
import { createMcpHttpHandler } from "@steelyard/protocol/mcp";
import {
  STEELYARD_CHECKOUT_MANDATE_V01,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_CHECKOUT_CAPABILITY,
  buildUcpDiscovery,
  createUcpHandler
} from "@steelyard/protocol/ucp";
import {
  applyCompleteRequest as applyAcpComplete,
  applyCreateRequest as applyAcpCreate,
  type CheckoutSession
} from "@steelyard/protocol/acp/checkout";
import {
  applyUcpComplete,
  applyUcpCreate,
  applyUcpUpdate,
  type Checkout as UcpCheckout
} from "@steelyard/protocol/ucp/checkout";
import {
  BuyerHmsProfileMissing,
  MerchantNoCheckout,
  Steelyard,
  UCP_LEGACY_CAPABILITY_ALIASES,
  connect,
  isCompatibleReadVersion,
  type Merchant
} from "./index.js";

const manifest = defineCommerce({
  identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["usd"] },
  offers: [
    {
      id: "double",
      title: "Double Espresso",
      description: "Two shots.",
      images: ["https://coffee.example/double.png"],
      url: "https://coffee.example/double",
      categories: ["espresso"],
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 450, currency: "usd" }]
    },
    {
      id: "single",
      title: "Single Espresso",
      description: "One shot.",
      categories: ["espresso"],
      availability: "preorder",
      pricing: [{ kind: "one_time", amount: 300, currency: "usd" }]
    }
  ],
  policies: [
    { type: "shipping", url: "https://coffee.example/shipping", summary: "Local courier." },
    { type: "returns", url: "https://coffee.example/returns", summary: "Prepared drinks are final." },
    { type: "refunds", url: "https://coffee.example/refunds", summary: "Refunds for order mistakes." },
    { type: "terms", url: "https://coffee.example/terms", summary: "Standard terms." },
    { type: "privacy", url: "https://coffee.example/privacy", summary: "Privacy policy." },
    { type: "other", url: "https://coffee.example/help", summary: "Help center." }
  ]
});

const now = new Date("2026-01-02T03:04:05.000Z");

let server: NodeServer | undefined;

interface CapturedRequest {
  path: string;
  idempotencyKey?: string;
  body: unknown;
}

afterEach(async () => {
  await closeServer();
});

async function closeServer(): Promise<void> {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
}

describe("Steelyard.connect", () => {
  it("detects MCP first and exposes unified merchant methods", async () => {
    const base = await startMerchantServer();
    const merchant = await Steelyard.connect(`${base}/mcp`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("mcp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.supports("read")).toBe(true);
    expect(merchant.supports("checkout")).toBe(false);
    await expectMerchantBasics(merchant);
    expect((await merchant.lookup("single") as { title: string }).title).toBe("Single Espresso");
    expect(await merchant.getManifest()).toMatchObject({
      identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["USD"] }
    });
    expect((await merchant.getPolicies() as unknown[])).toHaveLength(6);
    expect(await merchant.getOffer("missing")).toMatchObject({ error: "not_found" });
    await expect(merchant.purchase(purchaseIntent("mcp", `${base}/mcp`), { port: {} as never })).rejects.toMatchObject({
      name: "MerchantNoCheckout",
      protocol: "mcp",
      reason: expect.stringContaining("MCP checkout")
    });
    await expect(merchant.close?.()).resolves.toBeUndefined();
  });

  it("detects ACP feeds and reconstructs offers from ProductsResponse", async () => {
    const base = await startMerchantServer();
    const merchant = await connect(`${base}/acp/feed`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("acp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.supports("read")).toBe(true);
    expect(merchant.supports("checkout")).toBe(false);
    expect(merchant.supports("discounts")).toBe(false);
    expect((merchant.supports as (capability: string) => boolean)("unknown")).toBe(false);
    expect((await merchant.search("") as { id: string }[]).map((offer) => offer.id)).toEqual([
      "double",
      "single"
    ]);
    expect((await merchant.lookup("single") as { title: string }).title).toBe("Single Espresso");
    expect((await merchant.search("double") as { id: string }[]).map((offer) => offer.id)).toEqual(["double"]);
    expect(await merchant.getManifest()).toMatchObject({
      identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["USD"] }
    });
    expect((await merchant.getPolicies() as { type: string }[]).map((policy) => policy.type)).toEqual([
      "shipping",
      "returns",
      "refunds",
      "terms",
      "privacy",
      "other"
    ]);
    expect(await merchant.getOffer("missing")).toEqual({
      error: "not_found",
      error_detail: "Offer not found: missing"
    });
    await expect(merchant.purchase(purchaseIntent("acp", `${base}/acp/feed`), { port: {} as never })).rejects.toBeInstanceOf(
      MerchantNoCheckout
    );
  });

  it("handles ACP merchant id and variant-level offer fallbacks", async () => {
    const base = await startAcpFallbackServer();
    const merchant = await connect(`${base}/acp/feed`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("acp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.id).toBe("merchant_from_id");
    expect(merchant.supports("discounts")).toBe(true);
    const offers = await merchant.search("");
    expect(offers).toEqual([
      expect.objectContaining({
        id: "variant-only",
        title: "Variant Latte",
        description: "Variant description",
        images: ["https://coffee.example/variant.png"],
        url: "https://coffee.example/variant",
        availability: "unknown",
        pricing: []
      })
    ]);
    await expect(merchant.getManifest()).resolves.toMatchObject({
      identity: { name: "Variant Seller" }
    });
    await expect(merchant.getPolicies()).resolves.toEqual([]);
  });

  it("detects UCP discovery and uses the REST catalog service", async () => {
    const base = await startMerchantServer();
    const merchant = await connect(`${base}/.well-known/ucp`, { allowPrivateNetwork: true });

    expect(isMerchant(merchant) && merchant.protocol).toBe("ucp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.supports("read")).toBe(true);
    expect(merchant.supports("checkout")).toBe(false);
    expect(merchant.supports("checkout:steelyard")).toBe(false);
    expect(merchant.supports("discounts")).toBe(false);
    expect((merchant.supports as (capability: string) => boolean)("unknown")).toBe(false);
    await expectMerchantBasics(merchant);
    expect((await merchant.lookup("single") as { title: string }).title).toBe("Single Espresso");
    expect(await merchant.getManifest()).toMatchObject({
      identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["USD"] }
    });
    expect(await merchant.getOffer("missing")).toEqual({
      error: "not_found",
      error_detail: "HTTP 404"
    });
    expect((await merchant.getPolicies()) as unknown[]).toEqual([]);
    await expect(merchant.purchase(purchaseIntent("ucp", base), { port: {} as never })).rejects.toBeInstanceOf(
      MerchantNoCheckout
    );
  });

  it("requires explicit private-network opt-in for loopback UCP discovery", async () => {
    const base = await startMerchantServer();

    await expect(connect(`${base}/.well-known/ucp`)).resolves.toMatchObject({
      error: "protocol_mismatch",
      error_detail: expect.stringContaining("HTTPS")
    });
  });

  it("falls back from a base URL to UCP well-known discovery", async () => {
    const base = await startMerchantServer();
    const merchant = await connect(base, { allowPrivateNetwork: true });

    expect(isMerchant(merchant) && merchant.protocol).toBe("ucp");
  });

  it("uses the default UCP REST endpoint and maps UCP product fallbacks", async () => {
    const base = await startUcpDefaultEndpointServer();
    const merchant = await connect(base, { allowPrivateNetwork: true });

    expect(isMerchant(merchant) && merchant.protocol).toBe("ucp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.url).toBe(`${base}/api`);
    await expect(merchant.search("variant")).resolves.toEqual([
      expect.objectContaining({
        id: "variant-only",
        description: "Variant description",
        images: ["https://coffee.example/variant.png"],
        url: "https://coffee.example/variant",
        categories: ["coffee"],
        availability: "unknown",
        pricing: []
      })
    ]);
    await expect(merchant.getOffer("broken")).resolves.toEqual({
      error: "internal_error",
      error_detail: "UCP product has no variants: broken"
    });
  });

  it("sniffs ACP checkout capability from capabilities.services", async () => {
    const base = await startAcpCapabilityServer(["read", "checkout"]);
    const merchant = await connect(`${base}/acp/feed`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("acp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.supports("checkout")).toBe(true);
    expect(merchant.supports("checkout:steelyard")).toBe(false);
  });

  it("normalizes ACP well-known discovery URLs to the checkout route base", async () => {
    const base = await startAcpCapabilityServer(["read", "checkout"]);
    const merchant = await connect(`${base}/.well-known/acp.json`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("acp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.url).toBe(`${base}/acp`);
    expect(merchant.supports("checkout")).toBe(true);
  });

  it("accepts legacy UCP discovery bucket/id capabilities for read compatibility", async () => {
    const base = await startLegacyUcpDiscoveryServer();
    const merchant = await connect(base, { allowPrivateNetwork: true });

    expect(isMerchant(merchant) && merchant.protocol).toBe("ucp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect(merchant.supports("read")).toBe(true);
    expect(merchant.supports("checkout")).toBe(false);
  });

  it("sniffs UCP checkout and Steelyard-mode capabilities independently", async () => {
    const steelyardBase = await startUcpDiscoveryServer({ checkout: true, steelyardMandate: true });
    const steelyardMerchant = await connect(steelyardBase, { allowPrivateNetwork: true });

    expect(isMerchant(steelyardMerchant) && steelyardMerchant.protocol).toBe("ucp");
    if (!isMerchant(steelyardMerchant)) throw new Error("Expected merchant");
    expect(steelyardMerchant.supports("checkout")).toBe(true);
    expect(steelyardMerchant.supports("checkout:steelyard")).toBe(true);

    await closeServer();

    const ap2Base = await startUcpDiscoveryServer({ checkout: true, steelyardMandate: false });
    const ap2Merchant = await connect(ap2Base, { allowPrivateNetwork: true });

    expect(isMerchant(ap2Merchant) && ap2Merchant.protocol).toBe("ucp");
    if (!isMerchant(ap2Merchant)) throw new Error("Expected merchant");
    expect(ap2Merchant.supports("checkout")).toBe(true);
    expect(ap2Merchant.supports("checkout:steelyard")).toBe(false);
  });

  it("fails fast when HMS buyer auth is configured without a signer profile URL", async () => {
    await expect(
      connect("https://coffee.example/.well-known/ucp", {
        ucpAuth: {
          preferred: "hms",
          signing: { kid: "wallet-p256", algorithm: "ES256" } as never
        }
      })
    ).rejects.toBeInstanceOf(BuyerHmsProfileMissing);
  });

  it("sniffs canonical, legacy, mixed, and absent UCP checkout capabilities", async () => {
    const canonicalBase = await startUcpDiscoveryServer({ checkout: true, steelyardMandate: true });
    const canonicalMerchant = await connect(canonicalBase, { allowPrivateNetwork: true });
    expect(isMerchant(canonicalMerchant) && canonicalMerchant.supports("checkout")).toBe(true);
    expect(isMerchant(canonicalMerchant) && canonicalMerchant.supports("checkout:steelyard")).toBe(true);
    await closeServer();

    const legacyBase = await startLegacyUcpDiscoveryServer({ checkout: true, steelyardMandate: true });
    const legacyMerchant = await connect(legacyBase, { allowPrivateNetwork: true });
    expect(isMerchant(legacyMerchant) && legacyMerchant.supports("checkout")).toBe(true);
    expect(isMerchant(legacyMerchant) && legacyMerchant.supports("checkout:steelyard")).toBe(true);
    await closeServer();

    const steelyardAlias = UCP_LEGACY_CAPABILITY_ALIASES[STEELYARD_CHECKOUT_MANDATE_V01]!;
    const mixedBase = await startUcpCapabilitiesServer({
      [UCP_CATALOG_SEARCH_CAPABILITY]: [{ version: "2026-04-17" }],
      [UCP_CHECKOUT_CAPABILITY]: [{ version: "2026-04-17" }],
      [steelyardAlias.bucket]: [{ id: steelyardAlias.id, version: "2026-04-17" }]
    });
    const mixedMerchant = await connect(mixedBase, { allowPrivateNetwork: true });
    expect(isMerchant(mixedMerchant) && mixedMerchant.supports("checkout")).toBe(true);
    expect(isMerchant(mixedMerchant) && mixedMerchant.supports("checkout:steelyard")).toBe(true);
    await closeServer();

    const absentBase = await startUcpDiscoveryServer({ checkout: false, steelyardMandate: false });
    const absentMerchant = await connect(absentBase, { allowPrivateNetwork: true });
    expect(isMerchant(absentMerchant) && absentMerchant.supports("checkout")).toBe(false);
    expect(isMerchant(absentMerchant) && absentMerchant.supports("checkout:steelyard")).toBe(false);
  });

  it("routes ACP merchant.purchase through the checkout driver", async () => {
    const { base, requests } = await startAcpCheckoutServer();
    const merchant = await connect(`${base}/acp/feed`, { delegatePaymentUrl: `${base}/delegate-override` });

    expect(isMerchant(merchant) && merchant.supports("checkout")).toBe(true);
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    const receipt = await merchant.purchase(purchaseIntent("acp", `${base}/acp/feed`), {
      port: testPort(),
      idempotencyKey: "purchase_acp",
      clock: () => now
    });

    const checkoutRequests = requests.filter((request) => request.idempotencyKey);
    expect(receipt.reference.acp?.checkout_session_id).toBe("cs_1");
    expect(checkoutRequests.map((request) => request.path)).toEqual([
      "/acp/checkout_sessions",
      "/delegate-override",
      "/acp/checkout_sessions/cs_1/complete"
    ]);
    expect(checkoutRequests.map((request) => request.idempotencyKey)).toEqual([
      "purchase_acp:create",
      "purchase_acp:delegate",
      "purchase_acp:complete"
    ]);
  });

  it("routes UCP merchant.purchase with Steelyard-mode support", async () => {
    const { base, requests } = await startUcpCheckoutServer();
    const port = testPort();
    const merchant = await connect(base, { allowPrivateNetwork: true, delegatePaymentUrl: `${base}/delegate-override` });

    expect(isMerchant(merchant) && merchant.supports("checkout:steelyard")).toBe(true);
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    const receipt = await merchant.purchase(purchaseIntent("ucp", base), {
      port,
      idempotencyKey: "purchase_ucp",
      clock: () => now
    });

    const checkoutRequests = requests.filter((request) => request.idempotencyKey);
    expect(receipt.reference.ucp?.checkout_id).toBe("checkout_1");
    expect(port.signMandatePayloads[0]?.aud).toBe(`${base}/.well-known/ucp`);
    expect(checkoutRequests.map((request) => request.path)).toEqual([
      "/api/checkout",
      "/api/checkout/checkout_1",
      "/delegate-override",
      "/api/checkout/checkout_1/complete"
    ]);
  });

  it("returns protocol_mismatch when no probe matches", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(server);
    const { port } = server.address() as { port: number };

    expect(await connect(`http://127.0.0.1:${port}/unknown`, { allowPrivateNetwork: true })).toEqual({
      error: "protocol_mismatch",
      error_detail: "Could not detect MCP, ACP, or UCP at the supplied URL."
    });
  });

  it("returns network_error for unreachable URLs and malformed URLs", async () => {
    expect(await connect("not a url")).toMatchObject({ error: "network_error" });
    expect(await connect("http://127.0.0.1:9/mcp")).toMatchObject({ error: "network_error" });
  });

  it("treats server errors and invalid JSON probes as protocol mismatches", async () => {
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/invalid-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not json");
        return;
      }
      sendJson(res, { error: "unavailable" }, 500);
    });
    await listen(server);
    const { port } = server.address() as { port: number };

    await expect(connect(`http://127.0.0.1:${port}/server-error`)).resolves.toMatchObject({
      error: "protocol_mismatch"
    });
    await expect(connect(`http://127.0.0.1:${port}/invalid-json`)).resolves.toMatchObject({
      error: "protocol_mismatch"
    });
  });

  it("returns version_mismatch for incompatible MCP read versions", async () => {
    server = createServer(createVersionedMcpHandler("0.2.0"));
    await listen(server);
    const { port } = server.address() as { port: number };

    expect(await connect(`http://127.0.0.1:${port}/mcp`)).toEqual({
      error: "version_mismatch",
      error_detail: "Server read version 0.2.0 is not compatible with 0.1."
    });
  });
});

describe("read version compatibility", () => {
  it("allows v0.1 patch variants and rejects pre-1.0 minor or major changes", () => {
    expect(isCompatibleReadVersion("0.1")).toBe(true);
    expect(isCompatibleReadVersion("0.1.9")).toBe(true);
    expect(isCompatibleReadVersion("v0.1.2")).toBe(true);
    expect(isCompatibleReadVersion("0.2.0")).toBe(false);
    expect(isCompatibleReadVersion("1.0.0")).toBe(false);
    expect(isCompatibleReadVersion("not-semver")).toBe(false);
  });
});

async function expectMerchantBasics(merchant: Merchant): Promise<void> {
  expect((await merchant.search("")) as { id: string }[]).toEqual([
    expect.objectContaining({ id: "double", title: "Double Espresso" }),
    expect.objectContaining({ id: "single", title: "Single Espresso" })
  ]);
  expect((await merchant.getOffer("single") as { title: string }).title).toBe("Single Espresso");
}

async function startMerchantServer(): Promise<string> {
  const mcp = createMcpHttpHandler(manifest);
  const ucp = createUcpHandler(manifest);
  server = createServer((req, res) => {
    if (req.url?.startsWith("/mcp")) {
      void mcp(req, res);
      return;
    }
    if (req.url?.startsWith("/acp/feed")) {
      sendJson(res, {
        ...buildAcpFeed(manifest),
        merchant: { domain: "coffee.example" },
        capabilities: { services: ["read"] }
      });
      return;
    }
    void ucp(req, res);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function startAcpCapabilityServer(services: string[]): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === "GET" && (req.url?.startsWith("/acp/feed") || req.url?.startsWith("/.well-known/acp.json"))) {
      sendJson(res, {
        ...buildAcpFeed(manifest),
        merchant: { domain: "coffee.example" },
        capabilities: { services }
      });
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function startAcpFallbackServer(): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/acp/feed")) {
      sendJson(res, {
        products: [
          {
            id: "variant-only",
            variants: [
              {
                id: "variant-only-default",
                title: "Variant Latte",
                description: { plain: "Variant description" },
                media: [{ url: "https://coffee.example/variant.png" }],
                url: "https://coffee.example/variant",
                categories: [],
                seller: { name: "Variant Seller", links: [] }
              }
            ]
          }
        ],
        merchant: { id: "merchant_from_id" },
        capabilities: { services: ["discounts"] }
      });
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function startLegacyUcpDiscoveryServer(
  opts: { checkout?: boolean; steelyardMandate?: boolean } = {}
): Promise<string> {
  const capabilities: Record<string, { id: string; version: string }[]> = {};
  for (const capabilityKey of [
    UCP_CATALOG_SEARCH_CAPABILITY,
    ...(opts.checkout ? [UCP_CHECKOUT_CAPABILITY] : []),
    ...(opts.steelyardMandate ? [STEELYARD_CHECKOUT_MANDATE_V01] : [])
  ]) {
    const alias = UCP_LEGACY_CAPABILITY_ALIASES[capabilityKey]!;
    capabilities[alias.bucket] ??= [];
    capabilities[alias.bucket]!.push({ id: alias.id, version: "2026-04-17" });
  }
  return await startUcpCapabilitiesServer(capabilities);
}

async function startUcpCapabilitiesServer(capabilities: Record<string, unknown[]>): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/.well-known/ucp")) {
      const baseUrl = `http://${req.headers.host}`;
      sendJson(res, {
        ucp: {
          version: "2026-04-17",
          services: {
            "dev.ucp.shopping": [
              {
                version: "2026-04-17",
                transport: "rest",
                endpoint: `${baseUrl}/api`
              }
            ]
          },
          capabilities,
          payment_handlers: {}
        },
        merchant: { name: "Acme Coffee", domain: "coffee.example" },
        links: { commerce_manifest: `${baseUrl}/commerce/manifest` }
      });
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function startUcpDefaultEndpointServer(): Promise<string> {
  server = createServer(async (req, res) => {
    const baseUrl = `http://${req.headers.host}`;
    if (req.method === "GET" && req.url?.startsWith("/.well-known/ucp")) {
      sendJson(res, {
        ucp: {
          version: "2026-04-17",
          services: {
            "dev.ucp.shopping": []
          },
          capabilities: {
            [UCP_CATALOG_SEARCH_CAPABILITY]: [{ version: "2026-04-17" }]
          },
          payment_handlers: {}
        },
        merchant: { name: "Acme Coffee", domain: "coffee.example" },
        links: { commerce_manifest: `${baseUrl}/commerce/manifest` }
      });
      return;
    }

    const body = await readJsonBody(req);
    if (req.method === "POST" && req.url === "/api/catalog/search") {
      const query = typeof (body as { query?: unknown }).query === "string"
        ? (body as { query: string }).query
        : "";
      sendJson(res, {
        products: query && !query.includes("variant") ? [] : [ucpVariantProduct()]
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/catalog/product") {
      const id = (body as { id?: string }).id;
      sendJson(res, { product: id === "broken" ? { id: "broken", title: "Broken", variants: [] } : ucpVariantProduct() });
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

function ucpVariantProduct(): Record<string, unknown> {
  return {
    id: "variant-only",
    title: "Variant Latte",
    variants: [
      {
        id: "variant-only-default",
        description: { plain: "Variant description" },
        media: [{ url: "https://coffee.example/variant.png" }],
        url: "https://coffee.example/variant",
        categories: [{ value: "coffee" }]
      }
    ]
  };
}

async function startUcpDiscoveryServer(opts: { checkout: boolean; steelyardMandate: boolean }): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/.well-known/ucp")) {
      sendJson(res, buildUcpDiscovery(manifest, { baseUrl: `http://${req.headers.host}`, ...opts }));
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function startAcpCheckoutServer(): Promise<{ base: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  let session: CheckoutSession | undefined;
  server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/acp/feed")) {
      sendJson(res, {
        ...buildAcpFeed(manifest),
        merchant: { domain: "coffee.example" },
        capabilities: { services: ["read", "checkout"] }
      });
      return;
    }

    const body = await readJsonBody(req);
    requests.push({ path: req.url ?? "/", idempotencyKey: idempotencyKey(req), body });
    if (req.method === "POST" && req.url === "/acp/checkout_sessions") {
      session = withAcpHandler(applyAcpCreate(body as Record<string, unknown>, { manifest, now, sessionId: "cs_1" }).next);
      sendJson(res, session);
      return;
    }
    if (req.method === "POST" && req.url === "/delegate-override") {
      sendJson(res, { id: "vt_1", created: now.toISOString(), metadata: {} });
      return;
    }
    if (req.method === "POST" && req.url === "/acp/checkout_sessions/cs_1/complete" && session) {
      sendJson(res, applyAcpComplete(session, body as Record<string, unknown>, {
        now,
        pspResult: { ok: true, psp_payment_id: "pi_1", status: "captured" }
      }).next);
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests };
}

async function startUcpCheckoutServer(): Promise<{ base: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  let checkout: UcpCheckout | undefined;
  server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/.well-known/ucp")) {
      sendJson(res, buildUcpDiscovery(manifest, {
        baseUrl: `http://${req.headers.host}`,
        checkout: true,
        steelyardMandate: true
      }));
      return;
    }

    const body = await readJsonBody(req);
    requests.push({ path: req.url ?? "/", idempotencyKey: idempotencyKey(req), body });
    if (req.method === "POST" && req.url === "/api/checkout") {
      checkout = withUcpHandler(applyUcpCreate(body as Record<string, unknown>, {
        now,
        checkoutId: "checkout_1",
        currency: "USD",
        links: []
      }).next);
      sendJson(res, checkout);
      return;
    }
    if (req.method === "PATCH" && req.url === "/api/checkout/checkout_1" && checkout) {
      checkout = applyUcpUpdate(checkout, body as Record<string, unknown>, { now }).next;
      sendJson(res, checkout);
      return;
    }
    if (req.method === "POST" && req.url === "/delegate-override") {
      sendJson(res, { id: "vt_1", created: now.toISOString(), metadata: {} });
      return;
    }
    if (req.method === "POST" && req.url === "/api/checkout/checkout_1/complete" && checkout) {
      sendJson(res, applyUcpComplete(checkout, body as { payment: { instruments: [] } }, {
        now,
        mandateOk: { subject_id: "subject_1", key_id: "mk_test" },
        pspResult: { ok: true, psp_payment_id: "pi_1", status: "captured" },
        orderId: "order_checkout_1",
        permalinkUrl: "https://coffee.example/orders/order_checkout_1"
      }).next);
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests };
}

function withAcpHandler(session: CheckoutSession): CheckoutSession {
  return {
    ...session,
    capabilities: {
      payment: {
        handlers: [
          {
            id: "stripe",
            name: "dev.steelyard.vault_token",
            display_name: "Vault token",
            version: "2026-04-17",
            spec: "https://steelyard.dev/specs/payment/vault-token",
            requires_delegate_payment: true,
            requires_pci_compliance: false,
            psp: "stripe",
            config_schema: "https://steelyard.dev/schemas/payment-handler-config.json",
            instrument_schemas: ["https://steelyard.dev/schemas/vault-token-instrument.json"],
            config: {}
          }
        ]
      }
    }
  };
}

function withUcpHandler(checkout: UcpCheckout): UcpCheckout {
  return {
    ...checkout,
    ucp: {
      ...(checkout.ucp as Record<string, unknown>),
      payment_handlers: {
        "net.steelyard": [
          {
            id: "stripe",
            version: "2026-04-17",
            spec: "https://steelyard.dev/specs/payment/vault-token",
            schema: "https://ucp.dev/schemas/payment_handler.json",
            config: { token_type: "vault_token" }
          }
        ]
      }
    }
  };
}

function testPort(): WalletDriverPort & { signMandatePayloads: Record<string, unknown>[] } {
  const signMandatePayloads: Record<string, unknown>[] = [];
  return {
    signMandatePayloads,
    billing: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      address: { line1: "1 Coffee St", city: "London", postal_code: "SW1A", country: "GB" }
    },
    async withRawCard(fn) {
      return await fn({
        id: "card_1",
        pan: "4242424242424242",
        cvc: "123",
        exp: "12/30",
        name_on_card: "Ada Lovelace",
        brand: "visa",
        last4: "4242",
        tags: []
      });
    },
    async signMandate(payload) {
      signMandatePayloads.push(payload as Record<string, unknown>);
      return { jwt: "signed.jwt", key_id: "mk_test" };
    },
    async pairwiseSubject(audience) {
      return `sub:${audience}`;
    },
    async mandatePublicKey() {
      return { jwk: { kty: "OKP", crv: "Ed25519", x: "test" }, key_id: "mk_test" };
    }
  };
}

function createVersionedMcpHandler(version: string) {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }
    const body = await readJsonBody(req);
    if (req.method === "POST" && isInitializeRequest(body)) {
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        }
      });
      const mcpServer = new Server(
        { name: "versioned", version: "0.1.0" },
        {
          capabilities: {
            tools: {},
            resources: {},
            extensions: { "steelyard/commerce": { commerce: { read: { version } } } }
          }
        }
      );
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400).end();
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const value = req.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
}

async function listen(target: NodeServer): Promise<void> {
  await new Promise<void>((resolve) => target.listen(0, () => resolve()));
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isMerchant(value: unknown): value is Merchant {
  return !!value && typeof value === "object" && "search" in value;
}

function purchaseIntent(protocol: PurchaseIntent["merchant"]["protocol"], transportUrl: string): PurchaseIntent {
  return {
    merchant: {
      domain: "coffee.example",
      transport_url: transportUrl,
      protocol
    },
    offer: { id: "double", title: "Double Espresso", categories: ["espresso"] },
    amount: 450,
    currency: "USD",
    intent_id: "intent_test"
  };
}
