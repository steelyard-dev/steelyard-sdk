import { createServer, request, type Server as NodeServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { defineCommerce } from "@steelyard/core";
import {
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_SHOPPING_SERVICE,
  UCP_VERSION,
  UCP_WELL_KNOWN_PATH,
  assertValidUcpDiscovery,
  buildUcpDiscovery,
  createUcpHandler,
  getProduct,
  lookupCatalog,
  searchCatalog,
  validateUcpDiscovery,
  type UcpCatalogResponse,
  type UcpProductResponse
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
      attributes: { strength: "bold" },
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
  policies: [{ type: "returns", summary: "Prepared drinks are final." }]
});

let server: NodeServer | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("buildUcpDiscovery", () => {
  it("declares the UCP shopping service and read-side catalog capabilities", () => {
    const doc = buildUcpDiscovery(manifest, { baseUrl: "https://shop.example/" });

    expect(UCP_WELL_KNOWN_PATH).toBe("/.well-known/ucp");
    expect(doc.merchant).toEqual({ name: "Acme Coffee", domain: "coffee.example" });
    expect(doc.ucp.version).toBe(UCP_VERSION);
    expect(Object.keys(doc.ucp.services)).toEqual([UCP_SHOPPING_SERVICE]);
    expect(doc.ucp.services[UCP_SHOPPING_SERVICE]).toEqual([
      expect.objectContaining({ transport: "rest", endpoint: "https://shop.example/api" }),
      expect.objectContaining({ transport: "mcp", endpoint: "https://shop.example/mcp" })
    ]);
    expect(Object.keys(doc.ucp.capabilities)).toEqual([
      UCP_CATALOG_SEARCH_CAPABILITY,
      UCP_CATALOG_LOOKUP_CAPABILITY
    ]);
    expect(doc.ucp.payment_handlers).toEqual({});
    expect(doc.links.commerce_manifest).toBe("https://shop.example/commerce/manifest");
    expect(validateUcpDiscovery(doc).valid).toBe(true);
    expect(() => assertValidUcpDiscovery(doc)).not.toThrow();
  });

  it("reports schema errors for invalid discovery documents", () => {
    const result = validateUcpDiscovery({ ucp: { version: "bad" } });

    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(() => assertValidUcpDiscovery({ ucp: { version: "bad" } })).toThrow(
      /UCP discovery failed/
    );
  });
});

describe("catalog mapping", () => {
  it("searches catalog products and returns UCP-shaped prices, variants, and capabilities", () => {
    const response = searchCatalog(manifest, { query: "double" });

    expect(response.ucp.capabilities[UCP_CATALOG_SEARCH_CAPABILITY]).toEqual([
      { version: UCP_VERSION }
    ]);
    expect(response.products.map((product) => product.id)).toEqual(["double"]);
    expect(response.products[0]!.price_range).toEqual({
      min: { amount: 450, currency: "USD" },
      max: { amount: 450, currency: "USD" }
    });
    expect(response.products[0]!.variants[0]!.availability).toEqual({
      available: true,
      status: "in_stock"
    });
    expect(response.products[0]!.media).toEqual([
      { type: "image", url: "https://coffee.example/double.png" }
    ]);
  });

  it("looks up requested ids and retrieves a single product", () => {
    const lookup = lookupCatalog(manifest, { ids: ["single", "missing"] });
    const product = getProduct(manifest, { id: "single" });

    expect(lookup.products.map((item) => item.id)).toEqual(["single"]);
    expect(product?.variants[0]!.availability).toEqual({ available: true, status: "preorder" });
    expect(getProduct(manifest, { id: "missing" })).toBeUndefined();
  });

  it("handles malformed request bodies and unpriced offers deterministically", () => {
    const unpriced = defineCommerce({
      identity: { name: "Unpriced", currencies: ["gbp"] },
      offers: [{ id: "quote", title: "Quote", pricing: [{ kind: "contact_sales" }] }]
    });

    expect(searchCatalog(unpriced, null).products[0]!.price_range.min).toEqual({
      amount: 0,
      currency: "GBP"
    });
    expect(lookupCatalog(unpriced, { ids: [1, "quote"] }).products.map((product) => product.id)).toEqual([
      "quote"
    ]);
  });
});

describe("createUcpHandler", () => {
  it("serves discovery and catalog endpoints over HTTP", async () => {
    server = createServer(createUcpHandler(manifest, { baseUrl: "https://public.example" }));
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    const discovery = await httpRequest(`${base}/.well-known/ucp`, "GET");
    expect(discovery.statusCode).toBe(200);
    expect((discovery.body as { merchant: { name: string } }).merchant.name).toBe("Acme Coffee");

    const search = await httpRequest(`${base}/api/catalog/search`, "POST", { query: "espresso" });
    expect((search.body as UcpCatalogResponse).products.map((product) => product.id)).toEqual([
      "double",
      "single"
    ]);

    const lookup = await httpRequest(`${base}/api/catalog/lookup`, "POST", { ids: ["double"] });
    expect((lookup.body as UcpCatalogResponse).products[0]!.id).toBe("double");

    const product = await httpRequest(`${base}/api/catalog/product`, "POST", { id: "single" });
    expect((product.body as UcpProductResponse).product.id).toBe("single");
  });

  it("supports HEAD discovery and request-derived base URLs", async () => {
    server = createServer(createUcpHandler(manifest));
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };

    const response = await httpRequest(`http://127.0.0.1:${port}/.well-known/ucp`, "HEAD");

    expect(response.statusCode).toBe(200);
    expect(response.rawBody).toBe("");
  });

  it("returns JSON errors for unsupported or missing routes", async () => {
    server = createServer(createUcpHandler(manifest));
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    expect((await httpRequest(`${base}/.well-known/ucp`, "POST")).statusCode).toBe(405);
    expect((await httpRequest(`${base}/api/catalog/product`, "POST", { id: "missing" })).body).toEqual({
      error: "not_found"
    });
    expect((await httpRequest(`${base}/api/unknown`, "POST", {})).body).toEqual({
      error: "not_found"
    });
    expect((await httpRequest(`${base}/api/catalog/search`, "GET")).body).toEqual({
      error: "not_found"
    });
  });
});

async function httpRequest(
  url: string,
  method: "GET" | "HEAD" | "POST",
  body?: unknown
): Promise<{
  statusCode: number;
  rawBody: string;
  body: unknown;
}> {
  return await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode ?? 0,
            rawBody,
            body: rawBody ? JSON.parse(rawBody) : undefined
          });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
