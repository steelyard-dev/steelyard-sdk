# `@steelyard/agent`

A CLI buyer-agent that combines `@steelyard/client` with an LLM (Anthropic by
default) so users can ask natural-language questions about a Steelyard
merchant.

```bash
npm install -g @steelyard/agent
# or
npx @steelyard/agent --merchant <url> "<prompt>"
```

The bin is exposed as `steelyard-agent`.

## Usage

```bash
# With Anthropic (richest answers)
export ANTHROPIC_API_KEY=sk-ant-...
steelyard-agent --merchant http://localhost:3000/mcp "what does this shop sell"

# Without an LLM — the naive parser handles a small grammar
steelyard-agent --merchant http://localhost:3000/acp/feed "show policies"
steelyard-agent --merchant http://localhost:3000/.well-known/ucp "tell me about offer double"
```

The agent will:

1. `Steelyard.connect()` to the URL (auto-detecting MCP / ACP / UCP).
2. With `ANTHROPIC_API_KEY` set, call Anthropic and use tool calls back into
   `@steelyard/client` to fetch offers / manifest / policies.
3. Without a key, fall back to a regex parser that recognizes a small
   grammar (`what does this shop sell`, `tell me about offer <id>`,
   `show policies`).
4. If the Anthropic call fails mid-run, print
   `(LLM provider failed: ...; falling back to naive parser)` and continue.
   The demo never dies on a single provider failure.

## Why a single LLM provider in v1

A multi-provider matrix (OpenAI, Google, etc. via Vercel AI SDK) was
considered for v1 and explicitly cut. Reason: three release-blocking
external dependencies tripled the maintenance and CI surface for marginal
demo gain.

v0.2+ will add a thin provider interface if there's demand. The naive
parser fallback ensures the agent reaches a receipt even without any
LLM provider at all.

## Verification

`packages/agent/src/agent.test.ts` covers both LLM and naive-parser paths
plus the provider-failure fallback. Coverage: ≥ 90% lines.

## What's next

- :material-rocket: [Quickstart](../getting-started.md) — the full demo.
- :material-shopping-search: [`@steelyard/client`](client.md) — the SDK the
  agent wraps.
