import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { buildAcpFeed } from "@steelyard/protocol/acp";
import { createCommerceManifestHandler } from "@steelyard/protocol/commerce-manifest";
import { HTTP_API_DEFAULT_PREFIX, createHttpApiHandler } from "@steelyard/protocol/http";
import { createMcpHttpHandler } from "@steelyard/protocol/mcp";
import { createUcpHandler } from "@steelyard/protocol/ucp";
import {
  COMMERCE_MANIFEST_PATH,
  COMMERCE_READ_VERSION,
  type CommerceManifestOpts,
  type CommerceManifestPeer,
  type PeerName
} from "@steelyard/core";
import { coffeeShopManifest } from "./catalog.js";

export interface CoffeeShopHandlerOptions {
  publicOrigin?: string;
  generatedAt?: string;
  clock?: () => Date;
}

interface CoffeeShopCommerceHandlers {
  wellKnown: RequestListener;
  httpApi: RequestListener;
}

export function createCoffeeShopHandler(opts: CoffeeShopHandlerOptions = {}) {
  const mcp = createMcpHttpHandler(coffeeShopManifest);
  const ucp = createUcpHandler(coffeeShopManifest);
  let commerceHandlers: CoffeeShopCommerceHandlers | undefined;

  function getCommerceHandlers(req: IncomingMessage): CoffeeShopCommerceHandlers {
    commerceHandlers ??= createCoffeeShopCommerceHandlers(resolvePublicOrigin(req, opts), opts);
    return commerceHandlers;
  }

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = requestPath(req);
    if (path === COMMERCE_MANIFEST_PATH) {
      void getCommerceHandlers(req).wellKnown(req, res);
      return;
    }
    if (path === HTTP_API_DEFAULT_PREFIX || path.startsWith(`${HTTP_API_DEFAULT_PREFIX}/`)) {
      void getCommerceHandlers(req).httpApi(req, res);
      return;
    }
    if (path.startsWith("/mcp")) {
      void mcp(req, res);
      return;
    }
    if (path.startsWith("/acp/feed")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ...buildAcpFeed(coffeeShopManifest),
        merchant: { domain: "coffee.example" },
        capabilities: { services: ["read"] }
      }));
      return;
    }
    void ucp(req, res);
  };
}

export function createCoffeeShopServer() {
  return createServer(createCoffeeShopHandler());
}

function createCoffeeShopCommerceHandlers(
  origin: string,
  opts: CoffeeShopHandlerOptions
): CoffeeShopCommerceHandlers {
  const manifestOpts: CommerceManifestOpts = {
    peers: coffeeShopPeers(origin),
    ...(opts.generatedAt ? { generatedAt: opts.generatedAt } : {}),
    ...(opts.clock ? { clock: opts.clock } : {})
  };
  return {
    wellKnown: createCommerceManifestHandler(coffeeShopManifest, manifestOpts),
    httpApi: createHttpApiHandler(coffeeShopManifest, manifestOpts)
  };
}

function coffeeShopPeers(origin: string): Partial<Record<PeerName, CommerceManifestPeer>> {
  const base = normalizeOrigin(origin);
  const steelyard_read_version = COMMERCE_READ_VERSION;
  return {
    acp: { url: `${base}/acp/feed`, protocol_version: "2026-04-17", steelyard_read_version },
    ucp: { url: `${base}/.well-known/ucp`, protocol_version: "2026-04-17", steelyard_read_version },
    mcp: { url: `${base}/mcp`, protocol_version: "0.1", steelyard_read_version },
    http: { url: `${base}${HTTP_API_DEFAULT_PREFIX}`, protocol_version: "0.1", steelyard_read_version }
  };
}

function resolvePublicOrigin(req: IncomingMessage, opts: CoffeeShopHandlerOptions): string {
  return normalizeOrigin(opts.publicOrigin ?? process.env.STEELYARD_PUBLIC_ORIGIN ?? requestOrigin(req));
}

function requestOrigin(req: IncomingMessage): string {
  return `http://${req.headers.host ?? "127.0.0.1"}`;
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}
