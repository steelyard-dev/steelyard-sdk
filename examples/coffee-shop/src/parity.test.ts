import type { Server as NodeServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Steelyard, type Merchant } from "steelyard/buyer/client";
import {
  COMMERCE_MANIFEST_PATH,
  validateCommerceManifest,
  type CommerceManifestDoc,
  type Offer
} from "steelyard/core";
import { createCoffeeShopServer } from "./server.js";

let server: NodeServer | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("coffee-shop protocol parity", () => {
  it("returns identical offer lists from MCP, ACP, and UCP", async () => {
    const base = await start();

    const mcp = await mcpOffers(`${base}/mcp`);
    const acp = await acpOffers(`${base}/acp/feed`);
    const ucp = await ucpOffers(`${base}/api/catalog/search`);

    expect(mcp).toEqual(acp);
    expect(acp).toEqual(ucp);
    expect(mcp).toEqual([
      { id: "cappuccino", title: "Cappuccino", price: { amount: 500, currency: "USD" } },
      { id: "double", title: "Double Espresso", price: { amount: 450, currency: "USD" } },
      { id: "single", title: "Single Espresso", price: { amount: 300, currency: "USD" } }
    ]);
  });

  it("returns identical buyer SDK results across MCP, ACP, and UCP", async () => {
    const base = await start();
    const merchants = await Promise.all([
      Steelyard.connect(`${base}/mcp`),
      Steelyard.connect(`${base}/acp/feed`),
      Steelyard.connect(`${base}/.well-known/ucp`, { allowPrivateNetwork: true })
    ]);

    const [mcp, acp, ucp] = merchants;
    if (!isMerchant(mcp) || !isMerchant(acp) || !isMerchant(ucp)) {
      throw new Error(`Connect failed: ${JSON.stringify(merchants)}`);
    }

    await expectSame(
      () => mcp.search(""),
      () => acp.search(""),
      () => ucp.search("")
    );
    await expectSame(
      () => mcp.getOffer("single"),
      () => acp.getOffer("single"),
      () => ucp.getOffer("single")
    );
    await expectSame(
      () => mcp.getManifest(),
      () => acp.getManifest(),
      () => ucp.getManifest()
    );
    await expectSame(
      () => mcp.getPolicies(),
      () => acp.getPolicies(),
      () => ucp.getPolicies()
    );
  });

  it("links UCP discovery to the served v0.4 manifest and HTTP API", async () => {
    const base = await start();

    const discoveryResponse = await fetch(`${base}/.well-known/ucp`);
    const discovery = await discoveryResponse.json() as { links: { commerce_manifest: string } };
    expect(discovery.links.commerce_manifest).toBe(`${base}${COMMERCE_MANIFEST_PATH}`);

    const manifestResponse = await fetch(discovery.links.commerce_manifest);
    expect(manifestResponse.status).toBe(200);
    const manifest = await manifestResponse.json() as CommerceManifestDoc;
    expect(validateCommerceManifest(manifest).valid).toBe(true);
    expect(manifest.peers.http?.url).toBe(`${base}/commerce`);

    const productsResponse = await fetch(`${base}/commerce/products?query=double`);
    expect(productsResponse.status).toBe(200);
    const products = await productsResponse.json() as { products: Array<{ id: string }> };
    expect(products.products.map((product) => product.id)).toEqual(["double"]);

    const oldManifestResponse = await fetch(`${base}/commerce/manifest`);
    expect(oldManifestResponse.status).toBe(404);
  });
});

async function start(): Promise<string> {
  server = createCoffeeShopServer();
  await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function mcpOffers(url: string): Promise<NormalizedOffer[]> {
  const client = new Client({ name: "parity", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const result = await client.callTool({ name: "list_offers", arguments: {} });
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  await client.close();
  return (JSON.parse(text) as Offer[]).map(normalizeOffer);
}

async function acpOffers(url: string): Promise<NormalizedOffer[]> {
  const response = await fetch(url);
  const feed = (await response.json()) as { products: AcpProduct[] };
  return feed.products.map((product) => {
    const variant = product.variants[0]!;
    return {
      id: product.id,
      title: product.title ?? variant.title,
      price: variant.price!
    };
  });
}

async function ucpOffers(url: string): Promise<NormalizedOffer[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const body = (await response.json()) as { products: UcpProduct[] };
  return body.products.map((product) => ({
    id: product.id,
    title: product.title,
    price: product.variants[0]!.price
  }));
}

function normalizeOffer(offer: Offer): NormalizedOffer {
  const price = offer.pricing.find(
    (item): item is Extract<Offer["pricing"][number], { amount: number; currency: string }> =>
      "amount" in item
  );
  if (!price) throw new Error(`Missing price for ${offer.id}`);
  return { id: offer.id, title: offer.title, price: { amount: price.amount, currency: price.currency } };
}

async function expectSame<T>(
  first: () => Promise<T>,
  second: () => Promise<T>,
  third: () => Promise<T>
): Promise<void> {
  const values = await Promise.all([first(), second(), third()]);
  expect(values[0]).toEqual(values[1]);
  expect(values[1]).toEqual(values[2]);
}

function isMerchant(value: unknown): value is Merchant {
  return !!value && typeof value === "object" && "search" in value;
}

interface NormalizedOffer {
  id: string;
  title: string;
  price: { amount: number; currency: string };
}

interface AcpProduct {
  id: string;
  title?: string;
  variants: { title: string; price?: { amount: number; currency: string } }[];
}

interface UcpProduct {
  id: string;
  title: string;
  variants: { price: { amount: number; currency: string } }[];
}
