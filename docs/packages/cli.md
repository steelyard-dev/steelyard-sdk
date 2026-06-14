# `@steelyard/cli`

Command-line tools for generating, validating, and diagnosing v0.4 commerce
manifests.

```bash
npm install -D @steelyard/cli
```

## Commands

### `steelyard validate <source>`

Validate a `commerce.json` document from a file, stdin, or URL:

```sh
steelyard validate ./commerce.json
cat commerce.json | steelyard validate -
steelyard validate https://coffee.example/.well-known/commerce.json
```

Use `--json` for machine-readable output and `--strict` to reject unknown
top-level fields.

URL validation rejects private-network targets by default to avoid SSRF-style
mistakes in automation. For local examples, opt in explicitly:

```sh
steelyard validate http://127.0.0.1:3000/.well-known/commerce.json --allow-private-network
```

### `steelyard manifest <source>`

Generate a v0.4 commerce manifest from a raw v0.3 `Manifest` JSON file, stdin,
or an ESM module export:

```sh
steelyard manifest ./examples/coffee-shop/dist/catalog.js \
  --module \
  --export coffeeShopManifest \
  --peer acp=https://coffee.example/acp/feed \
  --protocol-version acp=2026-04-17 \
  --peer http=https://coffee.example/commerce \
  --protocol-version http=0.1 \
  --generated-at 2026-06-14T00:00:00.000Z \
  --pretty
```

Every `--peer name=url` must have a matching
`--protocol-version name=value`; the manifest schema requires peer protocol
versions.

TypeScript module sources are intentionally rejected. Build first or run the
same module through `tsx` in your own script.

### `steelyard doctor`

Check that the CLI runtime can reach the built core commerce schema and compile
the v0.4 schema set:

```sh
steelyard doctor
steelyard doctor --json
```

`doctor` is read-side only. It does not check wallet, vault, keychain, PSP, or
checkout dependencies.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Valid command completed and found invalid manifest content. |
| `2` | Source could not be read. |
| `3` | Network fetch failed. |
| `4` | Bad arguments, unsupported source type, or invalid JSON/module shape. |

## Automation

The root `pnpm validate-examples` script starts each example server and runs the
CLI against `http://127.0.0.1:<port>/.well-known/commerce.json` with explicit
private-network opt-in.
