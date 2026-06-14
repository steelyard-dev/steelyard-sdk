# Commerce Manifest

The commerce manifest is the v0.4 static JSON form of a Steelyard
`defineCommerce()` manifest. It is served at:

```text
GET  /.well-known/commerce.json
HEAD /.well-known/commerce.json
```

It contains public read-side commerce data only: merchant identity, offers,
policies, peer protocol URLs, schema version, generation time, and a checksum.
It does not contain wallet data, checkout sessions, PSP credentials, raw card
data, secrets, or internal operational state.

## Build one

```ts
import { commerceManifest } from "@steelyard/core";

const doc = commerceManifest(manifest, {
  generatedAt: "2026-06-14T00:00:00.000Z",
  peers: {
    acp: { url: "https://coffee.example/acp/feed", protocol_version: "2026-04-17" },
    ucp: { url: "https://coffee.example/.well-known/ucp", protocol_version: "2026-04-17" },
    mcp: { url: "https://coffee.example/mcp", protocol_version: "0.1" },
    http: { url: "https://coffee.example/commerce", protocol_version: "0.1" }
  }
});
```

`commerceManifest()` validates the output against
`packages/core/spec/commerce-manifest/0.1/commerce-manifest.schema.json` before
returning it.

## Serve one

```ts
import { createServer } from "node:http";
import { createCommerceManifestHandler } from "@steelyard/protocol/commerce-manifest";

const wellKnown = createCommerceManifestHandler(manifest, {
  peers: {
    http: { url: "https://coffee.example/commerce", protocol_version: "0.1" }
  }
});

createServer((req, res) => {
  if (req.url?.startsWith("/.well-known/commerce.json")) return wellKnown(req, res);
  res.writeHead(404).end();
}).listen(3000);
```

The handler constructs the manifest once at startup, returns `ETag` and
`Cache-Control` headers, supports `If-None-Match`, and rejects unsupported
methods with the v0.4 error envelope.

## Shape

```json
{
  "$schema": "https://steelyard.dev/schemas/commerce-manifest/0.1.json",
  "schema_version": "0.1",
  "generated_at": "2026-06-14T00:00:00.000Z",
  "identity": { "name": "Steelyard Coffee", "domain": "coffee.example" },
  "offers": [
    {
      "id": "double",
      "title": "Double Espresso",
      "images": [],
      "kind": "product",
      "categories": [],
      "attributes": {},
      "availability": "in_stock",
      "pricing": [{ "kind": "one_time", "amount": 450, "currency": "USD" }]
    }
  ],
  "policies": [],
  "peers": {
    "http": {
      "url": "https://coffee.example/commerce",
      "protocol_version": "0.1",
      "steelyard_read_version": "0.1"
    }
  },
  "content_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

The example hash above is a placeholder. Real manifests compute
`content_hash` from the canonical document body, excluding `content_hash`
itself.

## Checksum

`content_hash` is a SHA-256 checksum over RFC 8785 canonical JSON with a
Steelyard domain tag. It detects accidental mismatch between the bytes a
consumer read and the manifest fields they parsed.

It is not a signature and does not prove who produced the document. Use HTTPS,
your own signing layer, or a transparency log if authenticity is required. See
[Integrity](../concepts/integrity.md).

## What's next

- [HTTP API](http.md) - the read-only `/commerce` endpoint set.
- [Static manifest guide](../guides/static-manifest.md) - generate and publish
  `commerce.json` without running a Steelyard server.
