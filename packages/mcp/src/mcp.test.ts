// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type Server as NodeServer } from "node:http";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { defineCommerce, type Manifest } from "@steelyard/core";
import {
  COMMERCE_CAPABILITY,
  createMcpHttpHandler,
  createMcpServer,
  getOffer,
  listOffers,
  runMcpStdio
} from "./index.js";

const manifest = defineCommerce({
  identity: { name: "Coffee Shop", domain: "coffee.example" },
  offers: [
    {
      id: "double",
      title: "Double Espresso",
      description: "Two shots of espresso.",
      categories: ["espresso"],
      attributes: { strength: "bold" },
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 450, currency: "usd" }]
    },
    {
      id: "single",
      title: "Single Espresso",
      description: "One shot of espresso.",
      categories: ["espresso"],
      attributes: { strength: "bright" },
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 300, currency: "usd" }]
    }
  ],
  policies: [{ type: "returns", summary: "No returns on prepared drinks." }]
});

let nodeServer: NodeServer | undefined;

afterEach(async () => {
  if (nodeServer) {
    await new Promise<void>((resolve) => nodeServer!.close(() => resolve()));
    nodeServer = undefined;
  }
});

describe("MCP tool helpers", () => {
  it("lists offers in canonical order and filters by free text", () => {
    const all = listOffers(manifest);
    const filtered = listOffers(manifest, { query: "bright", limit: 1 });

    expect(all.ok && (all.content as Manifest["catalog"]["offers"]).map((offer) => offer.id)).toEqual([
      "double",
      "single"
    ]);
    expect(filtered.ok && (filtered.content as Manifest["catalog"]["offers"]).map((offer) => offer.id)).toEqual([
      "single"
    ]);
  });

  it("returns an offer by id or a tool-level error", () => {
    expect(getOffer(manifest, { id: "double" })).toEqual({
      ok: true,
      content: manifest.catalog.offers[0]
    });
    expect(getOffer(manifest, { id: "missing" })).toEqual({
      ok: false,
      error: "Unknown offer id: missing"
    });
  });
});

describe("createMcpServer", () => {
  it("serves list_offers, get_offer, manifest, and policies through an MCP client", async () => {
    const client = await connectInMemory(manifest);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_offers", "get_offer"]);
    expect(tools[1]!.inputSchema).toMatchObject({ required: ["id"] });

    const listed = await client.callTool({ name: "list_offers", arguments: { query: "espresso" } });
    const listedOffers = JSON.parse(toolText(listed)) as Manifest["catalog"]["offers"];
    expect(listed.isError ?? false).toBe(false);
    expect(listedOffers.map((offer) => offer.id)).toEqual(["double", "single"]);

    const found = await client.callTool({ name: "get_offer", arguments: { id: "single" } });
    expect(JSON.parse(toolText(found)).title).toBe("Single Espresso");

    const missing = await client.callTool({ name: "get_offer", arguments: { id: "missing" } });
    expect(missing.isError).toBe(true);
    expect(toolText(missing)).toContain("Unknown offer id");

    const unknown = await client.callTool({ name: "unknown", arguments: {} });
    expect(unknown.isError).toBe(true);

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      "commerce://manifest",
      "commerce://policies"
    ]);

    const manifestResource = await client.readResource({ uri: "commerce://manifest" });
    expect(JSON.parse((manifestResource.contents[0] as { text: string }).text).identity.name).toBe(
      "Coffee Shop"
    );

    const policyResource = await client.readResource({ uri: "commerce://policies" });
    expect(JSON.parse((policyResource.contents[0] as { text: string }).text)).toEqual(manifest.policies);

    await expect(client.readResource({ uri: "commerce://missing" })).rejects.toThrow();
    await client.close();
  });

  it("advertises commerce read capability in the raw initialize result", async () => {
    const server = createMcpServer(manifest);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const responses: unknown[] = [];
    clientTransport.onmessage = (message) => responses.push(message);

    await Promise.all([server.connect(serverTransport), clientTransport.start()]);
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "raw-client", version: "0.0.0" }
      }
    });

    await waitFor(() => responses.length > 0);
    const response = responses[0] as {
      result: {
        serverInfo: { capabilities: { commerce: typeof COMMERCE_CAPABILITY } };
        capabilities: { extensions: Record<string, unknown> };
      };
    };
    expect(response.result.serverInfo.capabilities.commerce).toEqual(COMMERCE_CAPABILITY);
    expect(response.result.capabilities.extensions["steelyard/commerce"]).toEqual({
      commerce: COMMERCE_CAPABILITY
    });
    await clientTransport.close();
  });
});

describe("transports", () => {
  it("connects through runMcpStdio with a supplied transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stdio-client", version: "0.0.0" });

    await Promise.all([runMcpStdio(manifest, serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["list_offers", "get_offer"]);
    await client.close();
  });

  it("speaks streamable HTTP end-to-end", async () => {
    const handler = createMcpHttpHandler(manifest);
    nodeServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
    const { port } = nodeServer.address() as { port: number };
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    const client = new Client({ name: "http-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    const result = await client.callTool({ name: "list_offers", arguments: {} });
    const offers = JSON.parse(toolText(result)) as Manifest["catalog"]["offers"];

    expect(offers.map((offer) => offer.id)).toEqual(["double", "single"]);
    await client.close();
  });

  it("returns a 400 JSON response for requests without a known session", async () => {
    const handler = createMcpHttpHandler(manifest);
    nodeServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
    const { port } = nodeServer.address() as { port: number };

    const response = await postJson(`http://127.0.0.1:${port}/mcp`, { method: "tools/list" });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "Missing or unknown mcp-session-id" });
  });
});

async function connectInMemory(testManifest: Manifest): Promise<Client> {
  const server = createMcpServer(testManifest);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function toolText(result: unknown): string {
  const { content } = result as { content: { text: string }[] };
  return content[0]!.text;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for MCP response");
}

async function postJson(url: string, body: unknown): Promise<{ statusCode: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw) });
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
