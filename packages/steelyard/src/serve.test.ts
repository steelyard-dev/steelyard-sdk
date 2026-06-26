// Copyright (c) Steelyard contributors. MIT License.
//
// SV3: prove serveCommerce() reaches the same multi-protocol parity the hand-wired
// coffee-shop example does (examples/coffee-shop/src/parity.test.ts), but through the
// one-call helper and an inline manifest.

import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Steelyard, type Merchant } from "@steelyard/buyer/client";
import {
  COMMERCE_MANIFEST_PATH,
  defineCommerce,
  validateCommerceManifest,
  type CommerceManifestDoc
} from "@steelyard/core";
import { serveCommerce } from "./serve.js";

const manifest = defineCommerce({
  identity: { name: "Test Shop", domain: "test.example", currencies: ["USD"] },
  offers: [
    { id: "alpha", title: "Alpha", description: "The alpha product.", availability: "in_stock", pricing: [{ kind: "one_time", amount: 100, currency: "USD" }] },
    { id: "beta", title: "Beta", description: "The beta product.", availability: "in_stock", pricing: [{ kind: "one_time", amount: 250, currency: "USD" }] }
  ]
});

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(s: Server): Promise<string> {
  server = s;
  await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

function isMerchant(value: unknown): value is Merchant {
  return !!value && typeof value === "object" && "search" in value;
}

describe("serveCommerce", () => {
  it("serves identical offers across MCP, ACP, and UCP from one manifest", async () => {
    const base = await listen(serveCommerce(manifest));

    const merchants = await Promise.all([
      Steelyard.connect(`${base}/mcp`),
      Steelyard.connect(`${base}/acp/feed`),
      Steelyard.connect(`${base}/.well-known/ucp`, { allowPrivateNetwork: true })
    ]);
    const [mcp, acp, ucp] = merchants;
    if (!isMerchant(mcp) || !isMerchant(acp) || !isMerchant(ucp)) {
      throw new Error(`connect failed: ${JSON.stringify(merchants)}`);
    }

    const [m, a, u] = await Promise.all([mcp.search(""), acp.search(""), ucp.search("")]);
    expect(m).toEqual(a);
    expect(a).toEqual(u);
    expect(m).toHaveLength(2);
  });

  it("serves the commerce manifest + HTTP API wired to the served origin", async () => {
    const base = await listen(serveCommerce(manifest));

    const wk = await fetch(`${base}${COMMERCE_MANIFEST_PATH}`);
    expect(wk.status).toBe(200);
    const doc = (await wk.json()) as CommerceManifestDoc;
    expect(validateCommerceManifest(doc).valid).toBe(true);
    expect(doc.peers.http?.url).toBe(`${base}/commerce`);
    expect(doc.peers.mcp?.url).toBe(`${base}/mcp`);

    const products = await fetch(`${base}/commerce/products?query=beta`);
    expect(products.status).toBe(200);
    const body = (await products.json()) as { products: Array<{ id: string }> };
    expect(body.products.map((p) => p.id)).toEqual(["beta"]);
  });

  it("mounts only the protocols requested", async () => {
    const base = await listen(serveCommerce(manifest, { protocols: ["commerce", "http"] }));

    expect((await fetch(`${base}/acp/feed`)).status).toBe(404);

    const doc = (await (await fetch(`${base}${COMMERCE_MANIFEST_PATH}`)).json()) as CommerceManifestDoc;
    expect(doc.peers.acp).toBeUndefined();
    expect(doc.peers.http?.url).toBe(`${base}/commerce`);
  });
});
