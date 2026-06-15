// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { createServer, request, type Server as NodeServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { COMMERCE_MANIFEST_PATH, defineCommerce, type EcJwk } from "@steelyard/core";
import {
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_CHECKOUT_CAPABILITY,
  UCP_SHOPPING_SERVICE,
  UCP_VERSION,
  UCP_WELL_KNOWN_PATH,
  STEELYARD_CHECKOUT_MANDATE_V01,
  assertValidGetProductResponse,
  assertValidLookupResponse,
  assertValidSearchResponse,
  assertValidUcpDiscovery,
  buildUcpDiscovery,
  createUcpHandler,
  getProduct,
  lookupCatalog,
  searchCatalog,
  validateGetProductResponse,
  validateLookupResponse,
  validateSearchResponse,
  validateUcpDiscovery,
  type UcpCatalogResponse,
  type UcpDiscoveryDoc,
  type UcpLookupResponse,
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
    expect(doc.ucp.capabilities[UCP_CATALOG_SEARCH_CAPABILITY]).toEqual([
      expect.objectContaining({
        version: UCP_VERSION,
        spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-search`,
        schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json`
      })
    ]);
    expect(doc.ucp.capabilities[UCP_CATALOG_LOOKUP_CAPABILITY]).toEqual([
      expect.objectContaining({
        version: UCP_VERSION,
        spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-lookup`,
        schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json`
      })
    ]);
    expect(Object.values(doc.ucp.capabilities).flat().some((capability) => "id" in capability)).toBe(false);
    expect(doc.ucp.payment_handlers).toEqual({});
    expect(doc.links.commerce_manifest).toBe(`https://shop.example${COMMERCE_MANIFEST_PATH}`);
    expect(validateUcpDiscovery(doc).valid).toBe(true);
    expect(() => assertValidUcpDiscovery(doc)).not.toThrow();
  });

  it("can advertise checkout and Steelyard-mode mandate capabilities separately", () => {
    const doc = buildUcpDiscovery(manifest, {
      baseUrl: "https://shop.example/",
      checkout: true,
      steelyardMandate: true
    });

    expect(Object.keys(doc.ucp.capabilities)).toEqual([
      UCP_CHECKOUT_CAPABILITY,
      UCP_CATALOG_SEARCH_CAPABILITY,
      UCP_CATALOG_LOOKUP_CAPABILITY,
      STEELYARD_CHECKOUT_MANDATE_V01
    ]);
    expect(canonicalJson(doc.ucp.capabilities)).toBe(canonicalJson({
      [UCP_CHECKOUT_CAPABILITY]: [
        {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/checkout`,
          schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`
        }
      ],
      [UCP_CATALOG_SEARCH_CAPABILITY]: [
        {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-search`,
          schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json`
        }
      ],
      [UCP_CATALOG_LOOKUP_CAPABILITY]: [
        {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-lookup`,
          schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json`
        }
      ],
      [STEELYARD_CHECKOUT_MANDATE_V01]: [
        {
          version: UCP_VERSION,
          spec: "https://steelyard.dev/specification/checkout-mandate-v0.1",
          schema: "https://steelyard.dev/schemas/checkout-mandate-v0.1.json"
        }
      ]
    }));
    expect(doc.ucp.capabilities[UCP_CHECKOUT_CAPABILITY]).toEqual([
      {
        version: UCP_VERSION,
        spec: `https://ucp.dev/${UCP_VERSION}/specification/checkout`,
        schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`
      }
    ]);
    expect(doc.ucp.capabilities[STEELYARD_CHECKOUT_MANDATE_V01]).toEqual([
      {
        version: UCP_VERSION,
        spec: "https://steelyard.dev/specification/checkout-mandate-v0.1",
        schema: "https://steelyard.dev/schemas/checkout-mandate-v0.1.json"
      }
    ]);
    expect(Object.values(doc.ucp.capabilities).flat().some((capability) => "id" in capability)).toBe(false);
    expect(validateUcpDiscovery(doc).valid).toBe(true);
  });

  it("publishes public-only HTTP Message Signature keys at profile top level", () => {
    const doc = buildUcpDiscovery(manifest, {
      baseUrl: "https://shop.example/",
      ucp: {
        auth: {
          hms: {
            enabled: true,
            signingKeys: [merchantP256PrivateKey, merchantP384PublicKey]
          }
        }
      }
    });

    expect(doc.signing_keys).toEqual([
      {
        kid: "merchant-p256",
        kty: "EC",
        crv: "P-256",
        x: merchantP256PrivateKey.x,
        y: merchantP256PrivateKey.y,
        use: "sig",
        alg: "ES256"
      },
      merchantP384PublicKey
    ]);
    expect(doc.ucp).not.toHaveProperty("signing_keys");
    expect(JSON.stringify(doc)).not.toContain("\"d\":");
    expect(validateUcpDiscovery(doc).valid).toBe(true);
  });

  it("rejects enabled HTTP Message Signature publishing without keys", () => {
    expect(() =>
      buildUcpDiscovery(manifest, {
        baseUrl: "https://shop.example/",
        ucp: {
          auth: {
            hms: {
              enabled: true,
              signingKeys: []
            }
          }
        }
      })
    ).toThrow(/signingKeys/);
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const merchantP256PrivateKey = {
  kid: "merchant-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const merchantP384PublicKey = {
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
  use: "sig",
  alg: "ES384"
} satisfies EcJwk;

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
    expect(product?.variants[0]?.availability).toEqual({ available: true, status: "preorder" });
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

describe("catalog response spec validation", () => {
  it("validates real searchCatalog output against catalog_search.json#/$defs/search_response", () => {
    const response = searchCatalog(manifest, { query: "double" });
    expect(validateSearchResponse(response).valid).toBe(true);
    expect(() => assertValidSearchResponse(response)).not.toThrow();
  });

  it("validates real lookupCatalog output against catalog_lookup.json#/$defs/lookup_response", () => {
    const response = lookupCatalog(manifest, { ids: ["double"] });
    expect(validateLookupResponse(response).valid).toBe(true);
    expect(() => assertValidLookupResponse(response)).not.toThrow();
  });

  it("validates real getProduct flow against catalog_lookup.json#/$defs/get_product_response", () => {
    // getProduct() returns only the product, but the underlying validator
    // wraps it in { ucp, product } and asserts it. We exercise both the
    // standalone validator and the assert helper here.
    const product = getProduct(manifest, { id: "double" });
    expect(product).toBeDefined();
    const wrapped = { ucp: searchCatalog(manifest, { query: "double" }).ucp, product };
    expect(validateGetProductResponse(wrapped).valid).toBe(true);
    expect(() => assertValidGetProductResponse(wrapped)).not.toThrow();
  });

  it("rejects search responses missing the required `products` array", () => {
    const tampered = { ucp: searchCatalog(manifest, {}).ucp };
    expect(validateSearchResponse(tampered).valid).toBe(false);
    expect(() => assertValidSearchResponse(tampered)).toThrow(
      /UCP catalog search response failed spec validation/
    );
  });

  it("rejects lookup responses whose variants are missing the `inputs` correlation", () => {
    const good = lookupCatalog(manifest, { ids: ["double"] });
    // Drop `inputs` from the first variant — spec requires it per lookup_variant.
    const tamperedProducts = good.products.map((product) => ({
      ...product,
      variants: product.variants.map(({ inputs: _drop, ...rest }) => rest)
    }));
    const tampered = { ...good, products: tamperedProducts };

    const result = validateLookupResponse(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors?.some((err) => /inputs/.test(err.message ?? ""))).toBe(true);
    expect(() => assertValidLookupResponse(tampered)).toThrow(
      /UCP catalog lookup response failed spec validation.*inputs/
    );
  });

  it("rejects get_product responses missing the required `product` field", () => {
    const tampered = { ucp: searchCatalog(manifest, {}).ucp };
    expect(validateGetProductResponse(tampered).valid).toBe(false);
    expect(() => assertValidGetProductResponse(tampered)).toThrow(
      /UCP catalog get_product response failed spec validation/
    );
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
    const lookupBody = lookup.body as UcpLookupResponse;
    expect(lookupBody.products[0]!.id).toBe("double");
    expect(lookupBody.products[0]!.variants[0]!.inputs).toEqual([{ id: "double", match: "exact" }]);

    const product = await httpRequest(`${base}/api/catalog/product`, "POST", { id: "single" });
    expect((product.body as UcpProductResponse).product.id).toBe("single");
  });

  it("passes HTTP Message Signature publishing options through discovery", async () => {
    server = createServer(createUcpHandler(manifest, {
      baseUrl: "https://public.example",
      ucp: {
        auth: {
          hms: {
            enabled: true,
            signingKeys: [merchantP256PrivateKey]
          }
        }
      }
    }));
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    const discovery = await httpRequest(`${base}/.well-known/ucp`, "GET");
    const body = discovery.body as UcpDiscoveryDoc;

    expect(body.signing_keys).toEqual([
      {
        kid: "merchant-p256",
        kty: "EC",
        crv: "P-256",
        x: merchantP256PrivateKey.x,
        y: merchantP256PrivateKey.y,
        use: "sig",
        alg: "ES256"
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("\"d\":");
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
