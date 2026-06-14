import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createAcpFeedHandler } from "@steelyard/protocol/acp";
import { defineCommerce } from "@steelyard/core";
import { createMcpHttpHandler } from "@steelyard/protocol/mcp";
import { createUcpHandler } from "@steelyard/protocol/ucp";
import { Steelyard, connect, isCompatibleReadVersion, type Merchant } from "./index.js";

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

let server: NodeServer | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("Steelyard.connect", () => {
  it("detects MCP first and exposes unified merchant methods", async () => {
    const base = await startMerchantServer();
    const merchant = await Steelyard.connect(`${base}/mcp`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("mcp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    await expectMerchantBasics(merchant);
    expect((await merchant.getManifest() as { identity: { name: string } }).identity.name).toBe("Acme Coffee");
    expect((await merchant.getPolicies() as unknown[])).toHaveLength(6);
    expect(await merchant.getOffer("missing")).toMatchObject({ error: "not_found" });
    await expect(merchant.close?.()).resolves.toBeUndefined();
  });

  it("detects ACP feeds and reconstructs offers from ProductsResponse", async () => {
    const base = await startMerchantServer();
    const merchant = await connect(`${base}/acp/feed`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("acp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    expect((await merchant.search("") as { id: string }[]).map((offer) => offer.id)).toEqual([
      "double",
      "single"
    ]);
    expect((await merchant.search("double") as { id: string }[]).map((offer) => offer.id)).toEqual(["double"]);
    expect((await merchant.getManifest() as { identity: { name: string } }).identity.name).toBe("Acme Coffee");
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
  });

  it("detects UCP discovery and uses the REST catalog service", async () => {
    const base = await startMerchantServer();
    const merchant = await connect(`${base}/.well-known/ucp`);

    expect(isMerchant(merchant) && merchant.protocol).toBe("ucp");
    if (!isMerchant(merchant)) throw new Error("Expected merchant");
    await expectMerchantBasics(merchant);
    expect((await merchant.getManifest() as { identity: { name: string } }).identity.name).toBe("Acme Coffee");
    expect(await merchant.getOffer("missing")).toEqual({
      error: "not_found",
      error_detail: "HTTP 404"
    });
    expect((await merchant.getPolicies()) as unknown[]).toEqual([]);
  });

  it("falls back from a base URL to UCP well-known discovery", async () => {
    const base = await startMerchantServer();
    const merchant = await connect(base);

    expect(isMerchant(merchant) && merchant.protocol).toBe("ucp");
  });

  it("returns protocol_mismatch when no probe matches", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(server);
    const { port } = server.address() as { port: number };

    expect(await connect(`http://127.0.0.1:${port}/unknown`)).toEqual({
      error: "protocol_mismatch",
      error_detail: "Could not detect MCP, ACP, or UCP at the supplied URL."
    });
  });

  it("returns network_error for unreachable URLs and malformed URLs", async () => {
    expect(await connect("not a url")).toMatchObject({ error: "network_error" });
    expect(await connect("http://127.0.0.1:9/mcp")).toMatchObject({ error: "network_error" });
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
  const acp = createAcpFeedHandler(manifest);
  const ucp = createUcpHandler(manifest);
  server = createServer((req, res) => {
    if (req.url?.startsWith("/mcp")) {
      void mcp(req, res);
      return;
    }
    if (req.url?.startsWith("/acp/feed")) {
      acp(req, res);
      return;
    }
    void ucp(req, res);
  });
  await listen(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
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

async function listen(target: NodeServer): Promise<void> {
  await new Promise<void>((resolve) => target.listen(0, () => resolve()));
}

function isMerchant(value: unknown): value is Merchant {
  return !!value && typeof value === "object" && "search" in value;
}
