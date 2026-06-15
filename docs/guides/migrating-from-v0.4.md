# Migrating From v0.4

v0.4.1 fixes the UCP discovery capability map to match the UCP specification
examples. Most Steelyard users do not need code changes.

## What changed

v0.4 emitted capabilities as short ids under authority buckets:

```json
{
  "capabilities": {
    "dev.ucp.shopping": [
      { "id": "checkout", "version": "2026-04-17" },
      { "id": "catalog.search", "version": "2026-04-17" }
    ],
    "net.steelyard": [
      { "id": "checkout_mandate.v0.1", "version": "2026-04-17" }
    ]
  }
}
```

v0.4.1 emits full capability names as map keys:

```json
{
  "capabilities": {
    "dev.ucp.shopping.checkout": [{ "version": "2026-04-17" }],
    "dev.ucp.shopping.catalog.search": [{ "version": "2026-04-17" }],
    "dev.ucp.shopping.catalog.lookup": [{ "version": "2026-04-17" }],
    "net.steelyard.checkout_mandate.v0_1": [{ "version": "2026-04-17" }]
  }
}
```

The Steelyard mandate key uses `v0_1` because UCP capability map keys must be
reverse-domain names whose dot-separated segments start with a lowercase
letter.

## What to update

If you call `buildUcpDiscovery()` or `createUcpHandler()`, update the package
and regenerate any pinned discovery fixtures. The emitted document changes
automatically.

If you inspect UCP capabilities yourself, check full map keys first. v0.4.1
buyers still accept the v0.3/v0.4 bucket/id form for one release, but v0.5
removes that fallback.

If you use `Steelyard.connect()`, no change is required. It accepts both v0.4
and v0.4.1 discovery documents during the migration window.
