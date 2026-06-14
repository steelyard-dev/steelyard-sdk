# Versioning

Steelyard follows a **pre-1.0 minor-match** rule for the read-side
capability version it advertises.

## The capability

Every Steelyard merchant declares a capability under its MCP `serverInfo`
(and equivalently in its ACP / UCP discovery surfaces):

```json
{
  "capabilities": {
    "commerce": {
      "read": { "version": "0.1" }
    }
  }
}
```

`@steelyard/buyer/client.connect()` reads this on the handshake and applies the
following compatibility rule:

| Client | Server | Result | Reason |
|--------|--------|--------|--------|
| `0.1`  | `0.1.x` (any patch) | ✅ Compatible | Patch bumps are non-breaking |
| `0.1`  | `0.2.x` | ❌ `version_mismatch` | **Minor bumps may break** at pre-1.0 |
| `0.1`  | `1.0.x` | ❌ `version_mismatch` | Major bump implies breaking change |

This matches the standard semver convention for `0.x.y` releases. Accepting
any `v0.x` server (the "major-version compat" rule used at `≥ 1.0`) would
miss real breaking changes — pre-1.0 minor bumps are deliberately the place
to put them.

## Why pre-1.0

Steelyard currently ships `commerce.read.version = "0.1"` even though package
versions can move independently. The two are not the same thing:

- **Package version** (`0.1.0`) — the npm version of the SDK. Follows
  standard semver for the TypeScript public API.
- **Capability version** (`0.1`) — the wire-level read shape: tool names,
  response shapes, error taxonomy, manifest schema, and HTTP read schema. This
  is what the buyer SDK negotiates over protocol handshakes.

The capability version stays at `0.1` until the read-side surface stabilizes.
It will bump to `0.2` if any of these change in a backward-incompatible way:

- The tool names emitted by `@steelyard/protocol/mcp`
- The `commerce.json` schema emitted by `@steelyard/protocol/commerce-manifest`
- The `/commerce` response schemas emitted by `@steelyard/protocol/http`
- The `ProductsResponse` shape emitted by `@steelyard/protocol/acp`
- The UCP discovery + catalog response shape
- The closed error taxonomy in `@steelyard/core`

A release that only adds a new capability can bump the package version without
bumping the read-side capability. New capabilities are additive.

## When does Steelyard go to `1.0`?

Read-side `1.0` ships when:

1. At least one merchant other than the example is running it in production.
2. The read-side surface has been stable for ≥ 3 months.
3. No breaking changes are queued.

At `1.0`, the version rule flips to **major-match**: a `1.x` client accepts
any `1.x` server. Breaking changes require a major bump and an explicit
migration guide.

## What's next

- :material-alert-circle: [Error taxonomy](errors.md) — `version_mismatch`
  is one of the closed client errors.
- :material-file-code: [Commerce manifest](../protocols/commerce-manifest.md)
  — the static read-side schema.
- :material-protocol: [MCP](../protocols/mcp.md#capability-handshake) — how
  the capability is advertised on the MCP `initialize` call.
