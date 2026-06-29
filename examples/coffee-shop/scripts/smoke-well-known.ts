import { createServer, type Server } from "node:http";
import {
  COMMERCE_MANIFEST_PATH,
  canonicalCommerceManifestHash,
  validateCommerceManifest,
  type CommerceManifestDoc
} from "steelyard/core";
import { createCoffeeShopHandler } from "../src/server.js";

const server = createServer(createCoffeeShopHandler({
  generatedAt: "2026-06-14T12:00:00.000Z"
}));

try {
  const baseUrl = await listen(server);
  const url = `${baseUrl}${COMMERCE_MANIFEST_PATH}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);

  const doc = await response.json() as CommerceManifestDoc;
  const validation = validateCommerceManifest(doc);
  if (!validation.valid) {
    throw new Error(`commerce manifest failed validation: ${JSON.stringify(validation.errors)}`);
  }

  const expectedHash = canonicalCommerceManifestHash(doc);
  if (doc.content_hash !== expectedHash) {
    throw new Error(`content_hash mismatch: expected ${expectedHash}, got ${doc.content_hash}`);
  }

  const head = await fetch(url, { method: "HEAD" });
  if (head.status !== 200) throw new Error(`HEAD ${url} returned HTTP ${head.status}`);
  if (head.headers.get("etag") !== `"${doc.content_hash.replace(/^sha256:/, "")}"`) {
    throw new Error("HEAD ETag did not match content_hash");
  }

  console.log(JSON.stringify({ ok: true, url, content_hash: doc.content_hash }, null, 2));
} finally {
  await closeServer(server);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
