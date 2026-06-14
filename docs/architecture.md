# Architecture

## Package dependency graph

```mermaid
graph TD
  core["@steelyard/core<br/><i>schema · types · ErrorCode · zod</i>"]
  mcp["@steelyard/protocol/mcp<br/><i>tools + resources<br/>@modelcontextprotocol/sdk</i>"]
  acp["@steelyard/protocol/acp<br/><i>ProductsResponse<br/>AJV spec validation</i>"]
  ucp["@steelyard/protocol/ucp<br/><i>discovery + catalog<br/>AJV spec validation</i>"]
  client["@steelyard/buyer/client<br/><i>auto-detect buyer SDK</i>"]
  agent["@steelyard/agent<br/><i>LLM-driven CLI</i>"]
  example["examples/coffee-shop<br/><i>private; not published</i>"]

  core --> mcp
  core --> acp
  core --> ucp
  core --> client
  mcp --> client
  client --> agent
  core --> example
  mcp --> example
  acp --> example
  ucp --> example
```

A CI lint rule enforces that `@steelyard/core` does **not** import from any
payment adapter, LLM provider, or framework. The dependency graph is
acyclic and protocol-agnostic at the core.

## Round-trip buyer flow (MCP example)

```mermaid
sequenceDiagram
  participant Agent as @steelyard/agent
  participant Client as @steelyard/buyer/client
  participant Merchant as Steelyard merchant
  participant LLM as Anthropic (optional)

  Agent->>+Client: connect(url)
  Client->>+Merchant: initialize (MCP)
  Merchant-->>-Client: serverInfo.capabilities.commerce<br/>{ read: { version: "0.1" } }
  Note over Client: version handshake<br/>(pre-1.0 minor-match)
  Client-->>-Agent: { protocol: "mcp", ... }

  Agent->>+LLM: plan(prompt, tools)
  LLM-->>-Agent: tool call: search("espresso")

  Agent->>+Client: merchant.search("espresso")
  Client->>+Merchant: list_offers
  Merchant-->>-Client: Offer[]
  Client-->>-Agent: Offer[]

  Agent->>+LLM: format answer with offers
  LLM-->>-Agent: natural-language response
```

The same `Steelyard.connect(url)` call works for ACP and UCP merchants —
the protocol detection is opaque to consumers.

## Spec discipline

Every protocol adapter validates its output against the vendored spec at
emit time:

| Adapter | Validator | Schema |
|---------|-----------|--------|
| `@steelyard/protocol/acp` | AJV2020 | `protocols/acp/spec/2026-04-17/json-schema/schema.feed.json` |
| `@steelyard/protocol/ucp` (discovery) | AJV2020 | `protocols/ucp/source/schemas/ucp.json` + transitive deps |
| `@steelyard/protocol/ucp` (catalog) | AJV2020 | `protocols/ucp/source/schemas/shopping/catalog_*.json` |
| `@steelyard/protocol/mcp` | — | Uses the official `@modelcontextprotocol/sdk`; conformance is by construction |

Bugs that would produce non-conformant output throw at emit time with the
specific spec violation. **No fake / incomplete stuff.**

## What's vendored

The protocol spec repos are vendored at `protocols/{acp,ucp,mcp}/` and
pinned to known-good versions:

- **ACP:** `2026-04-17` (json-schema, openapi, openrpc)
- **UCP:** `2026-04-08` (schemas + shopping service definition)
- **MCP:** runtime is `@modelcontextprotocol/sdk` ≥ 1.29

Bumping a spec version is a deliberate change: re-vendor, run the full test
suite (which includes adversarial spec-tampering cases), and ship a minor
release.

## What's next

- :material-protocol: [MCP](protocols/mcp.md), [ACP](protocols/acp.md),
  [UCP](protocols/ucp.md) — per-protocol surface details.
- :material-tag: [Versioning](concepts/versioning.md) — the read-side
  capability rule.
