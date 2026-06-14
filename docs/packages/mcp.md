# `@steelyard/protocol/mcp`

Emit an MCP server from a Steelyard manifest. Uses the official
`@modelcontextprotocol/sdk`.

```bash
npm install @steelyard/protocol @steelyard/core @modelcontextprotocol/sdk
```

## Exports

```typescript
import {
  createMcpServer,
  createMcpHttpHandler,
  runMcpStdio,
  COMMERCE_CAPABILITY,
  COMMERCE_EXTENSION_KEY,
  listOffers,
  getOffer
} from "@steelyard/protocol/mcp";
```

### `createMcpServer(manifest)` → `Server`

Builds an `@modelcontextprotocol/sdk` `Server` instance with the
`commerce.read` capability advertised, the `list_offers` and `get_offer`
tools registered, and the `commerce://manifest` + `commerce://policies`
resources wired. You attach it to any transport.

### `createMcpHttpHandler(manifest)` → `RequestListener`

A streamable-HTTP `RequestListener` you pass to Node's `http.createServer`.
This is what the [coffee-shop example](https://github.com/interfacelabs/steelyard-sdk/tree/main/examples/coffee-shop)
mounts at `/protocol/mcp`.

### `runMcpStdio(server)`

Wires the `Server` to a stdio transport for direct agent embedding.

## Capability

The `COMMERCE_CAPABILITY` constant is what gets advertised; `COMMERCE_EXTENSION_KEY`
(`"steelyard/commerce"`) is the namespace under MCP's `capabilities.extensions`
envelope. See the [MCP protocol page](../protocols/mcp.md#capability-handshake).

## Tool helpers

`listOffers(manifest, args)` and `getOffer(manifest, args)` are the same
functions used by the tool handlers; they're exported so you can call them
directly when embedding Steelyard in custom flows.

## Verification

`packages/protocol/src/mcp/mcp.test.ts` runs a real MCP client against the emitted
server and exercises every tool + resource. Coverage: ≥ 95% lines.

## What's next

- :material-protocol: [MCP protocol reference](../protocols/mcp.md).
- :material-shopping-search: [`@steelyard/buyer/client`](client.md) — the unified buyer SDK.
