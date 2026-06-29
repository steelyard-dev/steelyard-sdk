// Copyright (c) Steelyard contributors. MIT License.
import { createServer, request } from "node:http";
import type { RequestListener, Server as NodeServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMERCE_MANIFEST_PATH,
  canonicalCommerceManifestHash,
  defineCommerce,
  validateCommerceManifest
} from "@steelyard-dev/core";
import { createCommerceManifestHandler } from "./index.js";

const fixedDate = new Date("2026-06-14T12:00:00.000Z");
const manifest = defineCommerce({
  identity: { name: "Coffee", domain: "coffee.example", currencies: ["usd"] },
  offers: [{ id: "latte", title: "Latte", pricing: [{ kind: "one_time", amount: 550, currency: "usd" }] }],
  policies: [{ type: "returns", summary: "No returns on prepared drinks." }]
});

let nodeServer: NodeServer | undefined;

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: any;
}

afterEach(async () => {
  if (nodeServer) {
    await new Promise<void>((resolve) => nodeServer!.close(() => resolve()));
    nodeServer = undefined;
  }
  vi.restoreAllMocks();
});

describe("createCommerceManifestHandler", () => {
  it("serves a spec-valid stable commerce manifest with cache and etag headers", async () => {
    const handler = createCommerceManifestHandler(manifest, {
      clock: () => fixedDate,
      maxAgeSeconds: 60,
      peers: {
        http: { url: "https://coffee.example/commerce", protocol_version: "0.1" }
      }
    });
    const first = await get(handler, COMMERCE_MANIFEST_PATH);
    const second = await get(handler, COMMERCE_MANIFEST_PATH, {
      headers: { "if-none-match": String(first.headers.etag) }
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("application/json");
    expect(first.headers["cache-control"]).toBe("public, max-age=60");
    expect(first.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(validateCommerceManifest(first.body)).toMatchObject({ valid: true });
    expect(first.body.content_hash).toBe(canonicalCommerceManifestHash(first.body));
    expect(first.body.peers.http).toEqual({
      url: "https://coffee.example/commerce",
      protocol_version: "0.1"
    });
    expect(second.statusCode).toBe(304);
    expect(second.raw).toBe("");
  });

  it("handles HEAD, explicit cacheControl precedence, and generatedAt reproducibility", async () => {
    const firstHandler = createCommerceManifestHandler(manifest, {
      generatedAt: "2026-06-14T12:00:00.000Z",
      cacheControl: "no-store"
    });
    const secondHandler = createCommerceManifestHandler(manifest, { clock: () => fixedDate });
    const head = await get(firstHandler, COMMERCE_MANIFEST_PATH, { method: "HEAD" });
    const first = await get(firstHandler, COMMERCE_MANIFEST_PATH);
    const second = await get(secondHandler, COMMERCE_MANIFEST_PATH);

    expect(head.statusCode).toBe(200);
    expect(head.raw).toBe("");
    expect(head.headers["cache-control"]).toBe("no-store");
    expect(first.body).toEqual(second.body);
  });

  it("handles CORS preflight only when configured", async () => {
    const withoutCors = createCommerceManifestHandler(manifest, { clock: () => fixedDate });
    const withCors = createCommerceManifestHandler(manifest, {
      clock: () => fixedDate,
      cors: { origin: ["https://buyer.example"], maxAge: 600 }
    });

    const rejected = await get(withoutCors, COMMERCE_MANIFEST_PATH, { method: "OPTIONS" });
    const accepted = await get(withCors, COMMERCE_MANIFEST_PATH, {
      method: "OPTIONS",
      headers: { origin: "https://buyer.example" }
    });

    expect(rejected.statusCode).toBe(405);
    expect(rejected.body.error.code).toBe("method_not_allowed");
    expect(accepted.statusCode).toBe(204);
    expect(accepted.headers["access-control-allow-origin"]).toBe("https://buyer.example");
    expect(accepted.headers["access-control-max-age"]).toBe("600");
    expect(accepted.raw).toBe("");
  });

  it("returns 405 on owned-path wrong verbs without invoking fallthrough", async () => {
    const fallthrough = vi.fn();
    const handler = createCommerceManifestHandler(manifest, { clock: () => fixedDate, fallthrough });

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await get(handler, COMMERCE_MANIFEST_PATH, { method });
      expect(response.statusCode).toBe(405);
      expect(response.body.error.code).toBe("method_not_allowed");
    }
    expect(fallthrough).not.toHaveBeenCalled();
  });

  it("falls through for other paths and converts fallthrough throws before headers are sent", async () => {
    const handled = createCommerceManifestHandler(manifest, {
      clock: () => fixedDate,
      fallthrough: (_req, res) => {
        res.writeHead(204);
        res.end();
      }
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwing = createCommerceManifestHandler(manifest, {
      clock: () => fixedDate,
      fallthrough: () => {
        throw new Error("boom");
      }
    });

    expect((await get(handled, "/other")).statusCode).toBe(204);
    const failed = await get(throwing, "/other");
    expect(failed.statusCode).toBe(500);
    expect(failed.body.error.code).toBe("internal_error");
    expect(errorSpy).toHaveBeenCalled();
  });
});

async function get(
  handler: RequestListener,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {}
): Promise<HttpResponse> {
  nodeServer = createServer(handler);
  await new Promise<void>((resolve) => nodeServer!.listen(0, () => resolve()));
  const { port } = nodeServer.address() as { port: number };

  return await new Promise<HttpResponse>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            raw,
            body: raw ? JSON.parse(raw) : undefined
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  }).finally(async () => {
    await new Promise<void>((resolve) => nodeServer!.close(() => resolve()));
    nodeServer = undefined;
  });
}
