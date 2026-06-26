// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type IncomingMessage, type Server as NodeServer } from "node:http";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { defineCommerce, ecdsaSignRaw, type EcJwk, type HmsAlgorithm, type Manifest } from "@steelyard/core";
import { signUcpRequest, verifyUcpResponse } from "../ucp/index.js";
import {
  COMMERCE_CAPABILITY,
  createMcpHttpHandler,
  createMcpServer,
  getOffer,
  listOffers,
  runMcpStdio
} from "./index.js";

const now = new Date("2026-06-15T12:00:00.000Z");
const walletProfileUrl = "https://wallet.example/.well-known/ucp";
const walletUcpAgent = `profile="${walletProfileUrl}"`;

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
        serverInfo: Record<string, unknown>;
        capabilities: { extensions: Record<string, unknown> };
      };
    };
    expect(response.result.serverInfo).toEqual({
      name: "steelyard:Coffee Shop",
      version: "0.1.0"
    });
    expect(response.result.serverInfo).not.toHaveProperty("capabilities");
    expect(response.result.capabilities).not.toHaveProperty("commerce");
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

  it("verifies signed MCP HTTP requests and signs JSON responses", async () => {
    const handler = createMcpHttpHandler(manifest, {
      hms: {
        enabled: true,
        resolveKey: async (kid, signerProfileUrl) =>
          kid === "wallet-p256" && signerProfileUrl === walletProfileUrl ? walletP256PublicKey : null
      },
      responseSigning: {
        enabled: true,
        signing: signingMaterial("merchant-p256", "ES256", merchantP256PrivateKey)
      },
      clock: () => now
    });
    nodeServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
    const { port } = nodeServer.address() as { port: number };
    const url = `http://127.0.0.1:${port}/mcp`;
    const rawBody = JSON.stringify(initializeRequest());
    const signed = await signUcpRequest({
      method: "POST",
      url: new URL(url),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "idempotency-key": "mcp-init-1"
      },
      body: Buffer.from(rawBody, "utf8"),
      signing: signingMaterial("wallet-p256", "ES256", walletP256PrivateKey),
      ucpAgent: walletUcpAgent,
      now
    });

    const response = await postRaw(url, rawBody, signed.headers);

    expect(response.statusCode).toBe(200);
    expect(response.headers["signature-input"]).toBe(
      "sig1=(\"@status\" \"content-digest\" \"content-type\");keyid=\"merchant-p256\""
    );
    await expect(
      verifyUcpResponse({
        status: response.statusCode,
        headers: responseHeaders(response.headers),
        body: response.rawBody,
        resolveKey: async (kid) => (kid === "merchant-p256" ? merchantP256PublicKey : null),
        now
      })
    ).resolves.toEqual({ ok: true, kid: "merchant-p256", algorithm: "ES256" });
  });

  it("rejects unsigned MCP HTTP requests when HMS verification is enabled", async () => {
    const handler = createMcpHttpHandler(manifest, {
      hms: {
        enabled: true,
        resolveKey: async () => walletP256PublicKey
      },
      clock: () => now
    });
    nodeServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
    const { port } = nodeServer.address() as { port: number };

    const response = await postJson(`http://127.0.0.1:${port}/mcp`, initializeRequest(), {
      accept: "application/json, text/event-stream"
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "signature_missing",
        data: { ucp_code: "signature_missing" }
      },
      id: null
    });
  });

  it("maps MCP request digest mismatches to the UCP MCP error code", async () => {
    const handler = createMcpHttpHandler(manifest, {
      hms: {
        enabled: true,
        resolveKey: async () => walletP256PublicKey
      },
      clock: () => now
    });
    nodeServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
    const { port } = nodeServer.address() as { port: number };
    const url = `http://127.0.0.1:${port}/mcp`;
    const signedBody = JSON.stringify(initializeRequest());
    const tamperedBody = JSON.stringify({ ...(initializeRequest() as Record<string, unknown>), id: 99 });
    const signed = await signUcpRequest({
      method: "POST",
      url: new URL(url),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "idempotency-key": "mcp-init-2"
      },
      body: Buffer.from(signedBody, "utf8"),
      signing: signingMaterial("wallet-p256", "ES256", walletP256PrivateKey),
      ucpAgent: walletUcpAgent,
      now
    });

    const response = await postRaw(url, tamperedBody, signed.headers);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "digest_mismatch",
        data: { ucp_code: "digest_mismatch" }
      },
      id: null
    });
  });

  it("warns, but does not reject, when HTTP and MCP meta UCP-Agent profiles differ", async () => {
    const mismatches: unknown[] = [];
    const handler = createMcpHttpHandler(manifest, {
      onUcpAgentMismatch: (mismatch) => mismatches.push(mismatch)
    });
    nodeServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
    const { port } = nodeServer.address() as { port: number };
    const url = `http://127.0.0.1:${port}/mcp`;

    await postJson(url, mcpToolCallWithMeta("https://wallet.example/.well-known/ucp"), {
      "ucp-agent": walletUcpAgent
    });
    await postJson(url, mcpToolCallWithMeta("https://other-wallet.example/.well-known/ucp"), {
      "ucp-agent": walletUcpAgent
    });
    await postJson(url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, {
      "ucp-agent": walletUcpAgent
    });
    await postJson(url, mcpToolCallWithMeta("https://wallet.example/.well-known/ucp"));
    await postJson(url, { jsonrpc: "2.0", id: 5, method: "tools/list" });

    expect(mismatches).toEqual([
      {
        httpProfileUrl: "https://wallet.example/.well-known/ucp",
        metaProfileUrl: "https://other-wallet.example/.well-known/ucp"
      }
    ]);
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

function initializeRequest(): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "signed-http-client", version: "0.0.0" }
    }
  };
}

function mcpToolCallWithMeta(profile: string): unknown {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "list_offers",
      arguments: {
        meta: {
          "ucp-agent": { profile }
        }
      }
    }
  };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: unknown; headers: IncomingMessage["headers"]; rawBody: Uint8Array }> {
  const rawBody = JSON.stringify(body);
  const response = await postRaw(url, rawBody, { "content-type": "application/json", ...headers });
  return { ...response, body: JSON.parse(Buffer.from(response.rawBody).toString("utf8")) };
}

async function postRaw(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: unknown; headers: IncomingMessage["headers"]; rawBody: Uint8Array }> {
  return await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
            headers: res.headers,
            rawBody: Buffer.from(raw, "utf8")
          });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function responseHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out[name] = value.join(", ");
    else if (value !== undefined) out[name] = value;
  }
  return out;
}

function signingMaterial(kid: string, algorithm: HmsAlgorithm, privateKey: EcJwk) {
  return {
    kid,
    algorithm,
    sign: (data: Uint8Array) => ecdsaSignRaw({ algorithm, privateKeyJwk: privateKey, data })
  };
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const walletP256PublicKey = {
  kid: "wallet-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const walletP256PrivateKey = {
  ...walletP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

const merchantP256PublicKey = {
  ...walletP256PublicKey,
  kid: "merchant-p256"
} satisfies EcJwk;

const merchantP256PrivateKey = {
  ...merchantP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;
