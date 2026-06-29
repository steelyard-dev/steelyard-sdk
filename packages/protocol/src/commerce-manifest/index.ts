// Copyright (c) Steelyard contributors. MIT License.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  COMMERCE_MANIFEST_PATH,
  canonicalCommerceManifestHash,
  commerceManifest,
  type CommerceManifestOpts,
  type Manifest
} from "@steelyard-dev/core";
import {
  type CorsOpts,
  type Fallthrough,
  corsHeaders,
  invokeFallthrough,
  sendError,
  sendJson,
  sendOptions
} from "../internal/http.js";

export interface CommerceManifestHandlerOptions extends CommerceManifestOpts {
  cacheControl?: string;
  maxAgeSeconds?: number;
  cors?: CorsOpts;
  fallthrough?: Fallthrough;
}

export function createCommerceManifestHandler(
  manifest: Manifest,
  opts: CommerceManifestHandlerOptions = {}
): RequestListener {
  const doc = commerceManifest(manifest, opts);
  const body = JSON.stringify(doc);
  const etag = `"${doc.content_hash.replace(/^sha256:/, "")}"`;
  const cacheControl = opts.cacheControl ?? `public, max-age=${opts.maxAgeSeconds ?? 300}`;
  const headers = {
    "cache-control": cacheControl,
    etag,
    "content-length": Buffer.byteLength(body)
  };

  return async function handleCommerceManifest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== COMMERCE_MANIFEST_PATH) {
      await invokeFallthrough(req, res, opts.fallthrough);
      return;
    }

    if (req.method === "OPTIONS") {
      if (opts.cors) {
        sendOptions(req, res, opts.cors, ["GET", "HEAD", "OPTIONS"]);
        return;
      }
      sendError(req, res, 405, "method_not_allowed", "Method not allowed", {
        headers: { allow: "GET, HEAD, OPTIONS" }
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(req, res, 405, "method_not_allowed", "Method not allowed", {
        cors: opts.cors,
        headers: { allow: "GET, HEAD, OPTIONS" }
      });
      return;
    }

    if (matchesEtag(req.headers["if-none-match"], etag)) {
      res.writeHead(304, { ...headers, ...corsHeaders(req, opts.cors) });
      res.end();
      return;
    }

    sendJson(req, res, 200, doc, {
      cors: opts.cors,
      headers
    });
  };
}

export { COMMERCE_MANIFEST_PATH, canonicalCommerceManifestHash };
export type { CorsOpts };

function matchesEtag(value: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw) return false;
  return raw
    .split(",")
    .map((item) => item.trim())
    .includes(etag);
}
