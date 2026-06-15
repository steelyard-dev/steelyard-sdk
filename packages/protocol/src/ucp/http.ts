// Copyright (c) Steelyard contributors. MIT License.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Manifest } from "@steelyard/core";
import { getProduct, lookupCatalog, searchCatalog, type UcpProductResponse } from "./catalog.js";
import {
  assertValidUcpDiscovery,
  buildUcpDiscovery,
  UCP_WELL_KNOWN_PATH,
  type UcpDiscoveryOptions
} from "./discovery.js";

export interface UcpHandlerOptions extends Omit<UcpDiscoveryOptions, "baseUrl"> {
  baseUrl?: string;
}

export function createUcpHandler(manifest: Manifest, opts: UcpHandlerOptions = {}) {
  return async function handleUcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", requestBaseUrl(req, opts));

    if (url.pathname === UCP_WELL_KNOWN_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const doc = buildUcpDiscovery(manifest, { ...opts, baseUrl: requestBaseUrl(req, opts) });
      assertValidUcpDiscovery(doc);
      sendJson(res, 200, doc, req.method === "HEAD");
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const body = await readJsonBody(req);
    if (url.pathname === "/api/catalog/search") {
      sendJson(res, 200, searchCatalog(manifest, body));
      return;
    }
    if (url.pathname === "/api/catalog/lookup") {
      sendJson(res, 200, lookupCatalog(manifest, body));
      return;
    }
    if (url.pathname === "/api/catalog/product") {
      const product = getProduct(manifest, body);
      if (!product) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const response: UcpProductResponse = { ucp: searchCatalog(manifest, {}).ucp, product };
      sendJson(res, 200, response);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  };
}

function requestBaseUrl(req: IncomingMessage, opts: UcpHandlerOptions): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/$/, "");
  const host = req.headers.host ?? "localhost";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${Array.isArray(proto) ? proto[0] : proto}://${host}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(headOnly ? undefined : JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
