# Static Manifest

You can publish `commerce.json` without running a Steelyard HTTP server. Build a
manifest from the same `defineCommerce()` config, upload it to your static host,
and point `peers` at the live protocol endpoints.

## Build the example

```sh
pnpm --filter steelyard-example-coffee-shop build
```

The coffee-shop package exports the raw Steelyard manifest from
`examples/coffee-shop/dist/catalog.js` as `coffeeShopManifest`.

## Generate `commerce.json`

```sh
steelyard manifest ./examples/coffee-shop/dist/catalog.js \
  --module \
  --export coffeeShopManifest \
  --peer acp=https://coffee.example/acp/feed \
  --protocol-version acp=2026-04-17 \
  --peer ucp=https://coffee.example/.well-known/ucp \
  --protocol-version ucp=2026-04-17 \
  --peer mcp=https://coffee.example/mcp \
  --protocol-version mcp=0.1 \
  --peer http=https://coffee.example/commerce \
  --protocol-version http=0.1 \
  --generated-at 2026-06-14T00:00:00.000Z \
  --pretty \
  > public/commerce.json
```

Use a fixed `--generated-at` in reproducible builds. Without it, the CLI uses
the current UTC time and the `content_hash` changes on each generation.

## Validate before upload

```sh
steelyard validate public/commerce.json --strict
```

After upload:

```sh
steelyard validate https://coffee.example/.well-known/commerce.json
```

For local example servers, use HTTP and explicit private-network opt-in:

```sh
steelyard validate http://127.0.0.1:3000/.well-known/commerce.json --allow-private-network
```

## Keep peers absolute

Static manifests should use absolute peer URLs. A document hosted on a CDN can
then point at the origin that serves MCP, ACP, UCP, and the optional `/commerce`
HTTP API.

Do not use `/.well-known/commerce.json` as an authentication mechanism. The
manifest hash is an integrity checksum, not a signature. See
[Integrity](../concepts/integrity.md).
