# Quickstart

The 60-second demo: spin up an example coffee shop that exposes its catalog
across all three protocols, then have an LLM-driven agent CLI explore it.

## Prerequisites

- Node ≥ 20
- pnpm ≥ 9
- *(optional)* `ANTHROPIC_API_KEY` to use the LLM path of `@steelyard/agent`.
  Without it the agent uses a naive regex parser and still reaches an answer.

## Clone and install

```bash
git clone https://github.com/interfacelabs/steelyard-sdk.git steelyard
cd steelyard
pnpm install
pnpm -r build
```

## Boot the example merchant

```bash
pnpm --filter @steelyard/example-coffee-shop start
```

You should see something like:

```
MCP merchant listening at http://127.0.0.1:3000/mcp
ACP feed serving at      http://127.0.0.1:3000/acp/feed
UCP discovery at         http://127.0.0.1:3000/.well-known/ucp
```

**Same `defineCommerce({...})` config, three live protocol endpoints.** This
is the unification.

## Send the buyer agent to explore

In a second terminal:

```bash
# With Anthropic (best answers)
export ANTHROPIC_API_KEY=sk-ant-...
npx @steelyard/agent --merchant http://127.0.0.1:3000/mcp \
  "what does this shop sell"

# Without an LLM key — naive parser still answers
npx @steelyard/agent --merchant http://127.0.0.1:3000/mcp \
  "what does this shop sell"
```

Either way, the agent connects, fetches the offers, and prints an answer.

!!! tip "Switch protocols, same answer"
    Re-run the command pointing at `/acp/feed` or `/.well-known/ucp`. The
    agent returns the **identical offer list** because all three endpoints
    are emitted from the same config.

## What's next

- :material-cogs: Read about the [unification thesis](concepts/unification.md)
  and why three protocol surfaces from one config matters.
- :material-package: Drop `@steelyard/client` into your own agent runtime —
  see the [buyer SDK guide](packages/client.md).
- :material-tools: Build your own multi-protocol merchant — see
  [`defineCommerce`](concepts/define-commerce.md).
