// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import { defineCommerce } from "@steelyard/core";
import { createCommerceRoutes } from "./create-commerce-routes.js";

const manifest = defineCommerce({
  identity: { name: "Test", domain: "test.example", currencies: ["USD"] },
  offers: [
    {
      id: "x",
      title: "X",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 100, currency: "USD" }]
    }
  ]
});

describe("createCommerceRoutes", () => {
  it("returns one handler per surface", () => {
    const routes = createCommerceRoutes(manifest);
    expect(typeof routes.wellKnown).toBe("function");
    expect(typeof routes.mcp).toBe("function");
    expect(typeof routes.acpFeed).toBe("function");
    expect(typeof routes.ucp).toBe("function");
  });

  it("wellKnown returns the commerce manifest as JSON", async () => {
    const routes = createCommerceRoutes(manifest, { publicOrigin: "https://test.example" });
    const res = await routes.wellKnown(new Request("https://test.example/.well-known/commerce.json"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("identity");
    expect(body).toHaveProperty("offers");
  });

  it("acpFeed returns the ACP feed shape", async () => {
    const routes = createCommerceRoutes(manifest);
    const res = await routes.acpFeed(new Request("https://test.example/acp/feed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("products");
  });
});
