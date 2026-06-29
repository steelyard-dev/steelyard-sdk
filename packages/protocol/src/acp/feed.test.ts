// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type Server as NodeServer } from "node:http";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { defineCommerce } from "@steelyard-dev/core";
import {
  assertValidAcpFeed,
  buildAcpFeed,
  createAcpFeedHandler,
  validateAcpFeed,
  type AcpFeed
} from "./index.js";

const manifest = defineCommerce({
  identity: { name: "Acme Coffee", domain: "coffee.example" },
  offers: [
    {
      id: "single",
      title: "Single Espresso",
      description: "One shot.",
      images: ["https://coffee.example/single.png"],
      url: "https://coffee.example/single",
      availability: "in_stock",
      categories: ["espresso"],
      pricing: [{ kind: "one_time", amount: 300, currency: "usd" }]
    },
    {
      id: "slow",
      title: "Slow Bar",
      availability: "out_of_stock",
      pricing: [{ kind: "contact_sales" }]
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

describe("buildAcpFeed", () => {
  it("maps Steelyard offers to ACP ProductsResponse products and variants", () => {
    const feed = buildAcpFeed(manifest);
    const product = feed.products[1]!;
    const variant = product.variants[0]!;

    expect(feed.products.map((item) => item.id)).toEqual(["single", "slow"]);
    expect(product.id).toBe("slow");
    expect(feed.products[0]!.media).toEqual([
      { type: "image", url: "https://coffee.example/single.png" }
    ]);
    expect(feed.products[0]!.description).toEqual({ plain: "One shot." });
    expect(feed.products[0]!.variants[0]!.price).toEqual({ amount: 300, currency: "USD" });
    expect(feed.products[0]!.variants[0]!.availability).toEqual({
      available: true,
      status: "in_stock"
    });
    expect(feed.products[0]!.variants[0]!.categories).toEqual([
      { value: "espresso", taxonomy: "merchant" }
    ]);
    expect(feed.products[0]!.variants[0]!.seller).toEqual({
      name: "Acme Coffee",
      links: []
    });
    expect(variant.price).toBeUndefined();
    expect(variant.availability).toEqual({ available: false, status: "out_of_stock" });
    expect(validateAcpFeed(feed).valid).toBe(true);
    expect(() => assertValidAcpFeed(feed)).not.toThrow();
  });

  it("omits optional fields when the source offer does not provide them", () => {
    const feed = buildAcpFeed(
      defineCommerce({
        identity: { name: "Minimal" },
        offers: [{ id: "a", title: "A" }]
      })
    );

    expect(feed.products[0]).toEqual({
      id: "a",
      title: "A",
      description: undefined,
      url: undefined,
      media: undefined,
      variants: [
        {
          id: "a",
          title: "A",
          description: undefined,
          url: undefined,
          price: undefined,
          availability: { available: false, status: "unknown" },
          categories: [],
          media: undefined,
          seller: { name: "Minimal", links: [] }
        }
      ]
    });
  });

  it("rejects fields outside the ACP ProductsResponse schema", () => {
    const result = validateAcpFeed({ products: [], merchant: { name: "Acme" } });

    expect(result.valid).toBe(false);
    expect(result.errors?.some((error) => error.keyword === "additionalProperties")).toBe(true);
    expect(() => assertValidAcpFeed({ products: [], merchant: { name: "Acme" } })).toThrow(
      /ACP feed failed ProductsResponse validation/
    );
  });
});

describe("createAcpFeedHandler", () => {
  it("serves the ACP feed as JSON over HTTP GET", async () => {
    server = createServer(createAcpFeedHandler(manifest));
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };

    const response = await httpRequest(`http://127.0.0.1:${port}/acp/feed`, "GET");
    const feed = response.body as AcpFeed;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(feed.products.map((product) => product.id)).toEqual(["single", "slow"]);
    expect(validateAcpFeed(feed).valid).toBe(true);
  });

  it("serves headers without a body for HTTP HEAD", async () => {
    server = createServer(createAcpFeedHandler(manifest));
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };

    const response = await httpRequest(`http://127.0.0.1:${port}/acp/feed`, "HEAD");

    expect(response.statusCode).toBe(200);
    expect(response.rawBody).toBe("");
  });

  it("rejects unsupported methods with a JSON error", async () => {
    server = createServer(createAcpFeedHandler(manifest));
    await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };

    const response = await httpRequest(`http://127.0.0.1:${port}/acp/feed`, "POST");

    expect(response.statusCode).toBe(405);
    expect(response.body).toEqual({ error: "method_not_allowed" });
  });
});

async function httpRequest(
  url: string,
  method: "GET" | "HEAD" | "POST"
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: unknown;
}> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          rawBody,
          body: rawBody ? JSON.parse(rawBody) : undefined
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
