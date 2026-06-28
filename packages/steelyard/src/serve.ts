// Copyright (c) Steelyard contributors. MIT License.
//
// serveCommerce: define commerce once, serve every read surface from one manifest.
//
//   manifest ──┬─▶ /.well-known/commerce.json   (commerce manifest)
//              ├─▶ /commerce/*                   (plain HTTP API)
//              ├─▶ /mcp                          (MCP server)
//              ├─▶ /acp/feed                     (ACP product feed)
//              └─▶ /.well-known/ucp, /api/catalog/* (UCP discovery + catalog)
//
// This composes the existing per-protocol handlers behind one path router. It is a
// generalization of examples/coffee-shop/src/server.ts. The handlers do not self-check
// their mount path, so this router owns path routing; peer URLs in the commerce
// manifest are derived from the request origin (or opts.publicOrigin).

import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse
} from "node:http";
import { createAcpFeedHandler } from "@steelyard/protocol/acp";
import { createCommerceManifestHandler } from "@steelyard/protocol/commerce-manifest";
import { HTTP_API_DEFAULT_PREFIX, createHttpApiHandler } from "@steelyard/protocol/http";
import { createMcpHttpHandler, type McpHttpHandlerOptions } from "@steelyard/protocol/mcp";
import { createUcpHandler, type UcpHandlerOptions } from "@steelyard/protocol/ucp";
import {
  COMMERCE_MANIFEST_PATH,
  COMMERCE_READ_VERSION,
  type CommerceManifestOpts,
  type CommerceManifestPeer,
  type Manifest,
  type PeerName
} from "@steelyard/core";

/** A read surface that {@link serveCommerce} can mount. */
export type CommerceProtocol = "commerce" | "http" | "mcp" | "acp" | "ucp";

export interface ServeCommerceOptions {
  /**
   * Absolute origin advertised in the commerce manifest's peer URLs, e.g.
   * "https://shop.example". Defaults to `STEELYARD_PUBLIC_ORIGIN` or the request host.
   */
  publicOrigin?: string;
  /** Which read surfaces to mount. Defaults to all five. */
  protocols?: readonly CommerceProtocol[];
  /** Override the derived peer URLs in the commerce manifest. */
  peers?: Partial<Record<PeerName, CommerceManifestPeer>>;
  /** ISO timestamp stamped into the commerce manifest. */
  generatedAt?: string;
  /** Clock injection (testing). */
  clock?: () => Date;
  /** Advanced MCP handler options (auth, etc.). */
  mcp?: McpHttpHandlerOptions;
  /** Advanced UCP handler options (HMS auth, AP2, etc.). Read-only by default. */
  ucp?: UcpHandlerOptions;
}

const ALL_PROTOCOLS: readonly CommerceProtocol[] = ["commerce", "http", "mcp", "acp", "ucp"];
const ACP_FEED_PATH = "/acp/feed";
const MCP_PATH_PREFIX = "/mcp";

interface CommerceHandlers {
  wellKnown: RequestListener;
  httpApi: RequestListener;
}

/**
 * Build the multiplexed read request listener for a commerce manifest. Use this
 * when you want to mount the surfaces inside an existing server. For the common
 * case, call {@link serveCommerce} instead.
 */
export function createCommerceReadHandler(manifest: Manifest, opts: ServeCommerceOptions = {}): RequestListener {
  const enabled = new Set<CommerceProtocol>(opts.protocols ?? ALL_PROTOCOLS);
  const mcp = enabled.has("mcp") ? createMcpHttpHandler(manifest, opts.mcp ?? {}) : undefined;
  const ucp = enabled.has("ucp") ? createUcpHandler(manifest, opts.ucp ?? {}) : undefined;
  const acp = enabled.has("acp") ? createAcpFeedHandler(manifest) : undefined;

  let commerce: CommerceHandlers | undefined;
  const commerceHandlers = (req: IncomingMessage): CommerceHandlers => {
    commerce ??= buildCommerceHandlers(manifest, resolveOrigin(req, opts), opts, enabled);
    return commerce;
  };

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = requestPath(req);
    if (enabled.has("commerce") && path === COMMERCE_MANIFEST_PATH) {
      void commerceHandlers(req).wellKnown(req, res);
      return;
    }
    if (enabled.has("http") && (path === HTTP_API_DEFAULT_PREFIX || path.startsWith(`${HTTP_API_DEFAULT_PREFIX}/`))) {
      void commerceHandlers(req).httpApi(req, res);
      return;
    }
    if (mcp && path.startsWith(MCP_PATH_PREFIX)) {
      void mcp(req, res);
      return;
    }
    if (acp && path.startsWith(ACP_FEED_PATH)) {
      void acp(req, res);
      return;
    }
    if (ucp) {
      void ucp(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
}

/**
 * Serve a commerce manifest over every read surface (commerce.json, HTTP, MCP, ACP,
 * UCP) from one call. Returns a Node {@link Server} you can `.listen()` directly:
 *
 * ```ts
 * serveCommerce(manifest).listen(3000);
 * ```
 *
 * Read-only by default (no PSP required). Pass `opts.ucp`/`opts.mcp` for auth, or
 * mount createCheckoutServer separately for checkout.
 */
export function serveCommerce(manifest: Manifest, opts: ServeCommerceOptions = {}): Server {
  return createServer(createCommerceReadHandler(manifest, opts));
}

function buildCommerceHandlers(
  manifest: Manifest,
  origin: string,
  opts: ServeCommerceOptions,
  enabled: Set<CommerceProtocol>
): CommerceHandlers {
  const manifestOpts: CommerceManifestOpts = {
    peers: opts.peers ?? derivePeers(origin, enabled),
    ...(opts.generatedAt ? { generatedAt: opts.generatedAt } : {}),
    ...(opts.clock ? { clock: opts.clock } : {})
  };
  return {
    wellKnown: createCommerceManifestHandler(manifest, manifestOpts),
    httpApi: createHttpApiHandler(manifest, manifestOpts)
  };
}

function derivePeers(
  origin: string,
  enabled: Set<CommerceProtocol>
): Partial<Record<PeerName, CommerceManifestPeer>> {
  const base = normalizeOrigin(origin);
  const steelyard_read_version = COMMERCE_READ_VERSION;
  const peers: Partial<Record<PeerName, CommerceManifestPeer>> = {};
  if (enabled.has("acp")) {
    peers.acp = { url: `${base}/acp/feed`, protocol_version: "2026-04-17", steelyard_read_version };
  }
  if (enabled.has("ucp")) {
    peers.ucp = { url: `${base}/.well-known/ucp`, protocol_version: "2026-04-17", steelyard_read_version };
  }
  if (enabled.has("mcp")) {
    peers.mcp = { url: `${base}/mcp`, protocol_version: "0.1", steelyard_read_version };
  }
  if (enabled.has("http")) {
    peers.http = { url: `${base}${HTTP_API_DEFAULT_PREFIX}`, protocol_version: "0.1", steelyard_read_version };
  }
  return peers;
}

function resolveOrigin(req: IncomingMessage, opts: ServeCommerceOptions): string {
  return normalizeOrigin(
    opts.publicOrigin ?? process.env.STEELYARD_PUBLIC_ORIGIN ?? `http://${req.headers.host ?? "127.0.0.1"}`
  );
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}
