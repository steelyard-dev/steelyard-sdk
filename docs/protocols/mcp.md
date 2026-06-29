# MCP

Steelyard's MCP adapter (`steelyard/protocol/mcp`) emits a real
[Model Context Protocol](https://modelcontextprotocol.io/) server from a
`defineCommerce()` manifest. The runtime is the official
`@modelcontextprotocol/sdk` (≥ 1.29) — not a reimplementation.

## Capability handshake

On `initialize`, the server advertises:

```json
{
  "serverInfo": {
    "name": "steelyard:Acme Coffee",
    "version": "0.1.0"
  },
  "capabilities": {
    "tools": {},
    "resources": {},
    "extensions": {
      "steelyard/commerce": {
        "commerce": { "read": { "version": "0.1" } }
      }
    }
  }
}
```

The capability ships under `capabilities.extensions["steelyard/commerce"]`,
the MCP extension-registry path. `serverInfo` is the SDK `Implementation`
object and does not carry a `capabilities` subfield.

See [Versioning](../concepts/versioning.md) for the compatibility rule on the
`read.version` field.

## Tools

| Name | Input | Output |
|------|-------|--------|
| `list_offers` | `{ query?: string, limit?: number }` | `Offer[]` |
| `get_offer` | `{ id: string }` | `Offer \| null` |

Both return JSON-serialized [`Offer`](../concepts/define-commerce.md#offer)
objects. Searching is a case-insensitive substring match against
`id`, `title`, `description`, and `categories`.

## Resources

| URI | Returns |
|-----|---------|
| `commerce://manifest` | The full `Manifest` JSON (identity, offers, policies). |
| `commerce://policies` | A markdown rendering of all policies. |

Both are readable without auth.

## Transports

```typescript
import { createMcpServer, createMcpHttpHandler, runMcpStdio } from "steelyard/protocol/mcp";

// HTTP (streamable, used by the example coffee shop)
const handler = createMcpHttpHandler(manifest);
http.createServer(handler).listen(3000);

// stdio (for direct agent embedding)
const server = createMcpServer(manifest);
await runMcpStdio(server);
```

The HTTP transport uses MCP's streamable-HTTP convention and is reachable
from any `@modelcontextprotocol/sdk` client.

## Verification

Steelyard's MCP tests run a real `@modelcontextprotocol/sdk` client against
the emitted server, assert the capability shape, exercise `list_offers` and
`get_offer`, and read both resources end-to-end. See
[`packages/protocol/src/mcp/mcp.test.ts`](https://github.com/steelyard-dev/steelyard-sdk/blob/main/packages/protocol/src/mcp/mcp.test.ts).

## What's not on the wire

The MCP catalog tools above are read-side only. ACP and UCP have v0.3 checkout
support, but MCP checkout is intentionally absent from this release:

- `create_cart`, `checkout`, `get_receipt` — payment execution requires
  a protocol-specific checkout design.
- A `commerce.checkout` capability flag — future MCP checkout would be
  additive on top of `commerce.read`.

## What's next

- :material-protocol: [ACP](acp.md) — the spec-validated feed/catalog.
- :material-package-variant-closed: [`steelyard/protocol/mcp` package API](../packages/mcp.md).
