// Copyright (c) Steelyard contributors. MIT License.
import { createServer, request } from "node:http";
import type { RequestListener, Server as NodeServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCommerce, type Manifest } from "@steelyard-dev/core";
import { createHttpApiHandler, HTTP_API_DEFAULT_PREFIX } from "./index.js";

const fixedDate = new Date("2026-06-14T12:00:00.000Z");

function coffeeManifest(): Manifest {
  return defineCommerce({
    identity: { name: "Coffee Shop", domain: "coffee.example" },
    offers: [
      {
        id: "double",
        title: "Double Espresso",
        description: "Two shots of espresso.",
        categories: ["espresso"],
        attributes: { strength: "bold", shots: 2 },
        availability: "in_stock",
        pricing: [{ kind: "one_time", amount: 450, currency: "usd" }]
      },
      {
        id: "single",
        title: "Single Espresso",
        description: "One shot of espresso.",
        categories: ["espresso"],
        attributes: { strength: "bright", featured: true },
        availability: "in_stock",
        pricing: [{ kind: "one_time", amount: 300, currency: "usd" }]
      },
      {
        id: "beans",
        title: "House Beans",
        categories: ["retail"],
        attributes: { notes: ["chocolate", "citrus"] },
        availability: "in_stock",
        pricing: [{ kind: "one_time", amount: 1800, currency: "usd" }]
      }
    ],
    policies: [
      { type: "returns", summary: "No returns on prepared drinks." },
      { id: "privacy-page", type: "privacy", url: "https://coffee.example/privacy" }
    ]
  });
}

let nodeServer: NodeServer | undefined;

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: any;
}

afterEach(async () => {
  if (nodeServer) {
    await new Promise<void>((resolve) => nodeServer!.close(() => resolve()));
    nodeServer = undefined;
  }
  vi.restoreAllMocks();
});

describe("createHttpApiHandler", () => {
  it("serves the index, products, policies, and capabilities over the default prefix", async () => {
    const handler = createHttpApiHandler(coffeeManifest(), {
      clock: () => fixedDate,
      peers: { http: { url: "/commerce", protocol_version: "0.1" } }
    });

    const index = await get(handler, HTTP_API_DEFAULT_PREFIX);
    const products = await get(handler, "/commerce/products");
    const policies = await get(handler, "/commerce/policies");
    const capabilities = await get(handler, "/commerce/capabilities");

    expect(index.body).toEqual({
      schema_version: "0.1",
      links: {
        products: "/commerce/products",
        policies: "/commerce/policies",
        capabilities: "/commerce/capabilities"
      }
    });
    expect(products.body.products.map((offer: { id: string }) => offer.id)).toEqual(["beans", "double", "single"]);
    expect(products.body).toMatchObject({ total: 3, offset: 0, limit: 3 });
    expect(policies.body.policies.map((policy: { id: string }) => policy.id)).toEqual(["returns", "privacy-page"]);
    expect(capabilities.body.peers).toEqual({ http: { url: "/commerce", protocol_version: "0.1" } });
  });

  it("supports product and policy lookup with query-param ids", async () => {
    const handler = createHttpApiHandler(coffeeManifest(), { clock: () => fixedDate });

    const product = await get(handler, "/commerce/products?id=single");
    const missingProduct = await get(handler, "/commerce/products?id=missing");
    const policy = await get(handler, "/commerce/policies?id=privacy-page");
    const missingPolicy = await get(handler, "/commerce/policies?id=missing");

    expect(product.body.id).toBe("single");
    expect(missingProduct.statusCode).toBe(404);
    expect(missingProduct.body.error.code).toBe("not_found");
    expect(policy.body).toMatchObject({ id: "privacy-page", type: "privacy" });
    expect(missingPolicy.statusCode).toBe(404);
    expect(missingPolicy.body.error.code).toBe("not_found");
  });

  it("matches MCP free-text search semantics plus category, limit, and offset", async () => {
    const handler = createHttpApiHandler(coffeeManifest(), { clock: () => fixedDate });

    const byAttribute = await get(handler, "/commerce/products?query=bright");
    const byArrayAttribute = await get(handler, "/commerce/products?query=citrus");
    const byCategory = await get(handler, "/commerce/products?category=espresso&limit=1&offset=1");
    const bounded = await get(handler, "/commerce/products?limit=bad&offset=-10");

    expect(byAttribute.body.products.map((offer: { id: string }) => offer.id)).toEqual(["single"]);
    expect(byArrayAttribute.body.products.map((offer: { id: string }) => offer.id)).toEqual(["beans"]);
    expect(byCategory.body).toMatchObject({ total: 2, offset: 1, limit: 1 });
    expect(byCategory.body.products.map((offer: { id: string }) => offer.id)).toEqual(["single"]);
    expect(bounded.body).toMatchObject({ offset: 0, limit: 3 });
  });

  it("handles HEAD and CORS OPTIONS", async () => {
    const withoutCors = createHttpApiHandler(coffeeManifest(), { clock: () => fixedDate });
    const withCors = createHttpApiHandler(coffeeManifest(), {
      clock: () => fixedDate,
      cors: { origin: "*", headers: ["x-test"], methods: ["GET", "HEAD", "OPTIONS"], maxAge: 120 }
    });

    const head = await get(withCors, "/commerce/products", { method: "HEAD" });
    const rejectedOptions = await get(withoutCors, "/commerce/products", { method: "OPTIONS" });
    const acceptedOptions = await get(withCors, "/commerce/products", { method: "OPTIONS" });

    expect(head.statusCode).toBe(200);
    expect(head.raw).toBe("");
    expect(head.headers["content-length"]).toBeTruthy();
    expect(rejectedOptions.statusCode).toBe(405);
    expect(rejectedOptions.body.error.code).toBe("method_not_allowed");
    expect(acceptedOptions.statusCode).toBe(204);
    expect(acceptedOptions.headers["access-control-allow-origin"]).toBe("*");
    expect(acceptedOptions.headers["access-control-allow-headers"]).toBe("x-test");
  });

  it("405s recognized routes for wrong verbs but 404s unknown paths under the prefix", async () => {
    const handler = createHttpApiHandler(coffeeManifest(), { clock: () => fixedDate });

    for (const path of ["/commerce", "/commerce/products", "/commerce/policies", "/commerce/capabilities"]) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const response = await get(handler, path, { method });
        expect(response.statusCode).toBe(405);
        expect(response.body.error.code).toBe("method_not_allowed");
      }
    }

    const unknown = await get(handler, "/commerce/orders", { method: "POST" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body.error.code).toBe("not_found");
  });

  it("falls through outside the prefix and supports custom prefixes", async () => {
    const fallthrough = vi.fn((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const handler = createHttpApiHandler(coffeeManifest(), {
      prefix: "agent-commerce/",
      clock: () => fixedDate,
      fallthrough
    });

    const outside = await get(handler, "/commerce");
    const index = await get(handler, "/agent-commerce");

    expect(outside.statusCode).toBe(204);
    expect(fallthrough).toHaveBeenCalledOnce();
    expect(index.body.links.products).toBe("/agent-commerce/products");
  });

  it("keeps a deep-cloned construction snapshot when the caller mutates the source manifest", async () => {
    const source = coffeeManifest();
    const handler = createHttpApiHandler(source, { clock: () => fixedDate });
    source.catalog.offers[0]!.title = "" as never;
    source.policies.push({ type: "returns" });

    const products = await get(handler, "/commerce/products?id=beans");
    const policies = await get(handler, "/commerce/policies");

    expect(products.statusCode).toBe(200);
    expect(products.body.title).toBe("House Beans");
    expect(policies.body.policies.map((policy: { id: string }) => policy.id)).toEqual(["returns", "privacy-page"]);
  });

  it("returns a 500 envelope when fallthrough throws before writing headers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createHttpApiHandler(coffeeManifest(), {
      clock: () => fixedDate,
      fallthrough: () => {
        throw new Error("boom");
      }
    });

    const response = await get(handler, "/outside");
    expect(response.statusCode).toBe(500);
    expect(response.body.error.code).toBe("internal_error");
    expect(errorSpy).toHaveBeenCalled();
  });
});

async function get(
  handler: RequestListener,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {}
): Promise<HttpResponse> {
  nodeServer = createServer(handler);
  await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
  const { port } = nodeServer.address() as { port: number };

  return await new Promise<HttpResponse>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            raw,
            body: raw ? JSON.parse(raw) : undefined
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  }).finally(async () => {
    await new Promise<void>((resolve) => nodeServer!.close(() => resolve()));
    nodeServer = undefined;
  });
}
