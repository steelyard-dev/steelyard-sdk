# Quickstart

Under 2 minutes: install one package, define your catalog, serve it over every
read surface from one call.

## Build your own (under 2 minutes)

```bash
npm install steelyard
```

```ts title="server.ts"
import { defineCommerce, serveCommerce } from "steelyard";

const manifest = defineCommerce({
  identity: { name: "My Shop", domain: "shop.example", currencies: ["USD"] },
  offers: [
    {
      id: "single",
      title: "Single Espresso",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 300, currency: "USD" }]
    }
  ]
});

serveCommerce(manifest).listen(3000);
```

```bash
node server.ts   # or run via tsx / your bundler
curl localhost:3000/.well-known/commerce.json
```

That one `serveCommerce` call exposes your catalog over **five live read surfaces**
from a single manifest:

| Surface | Path |
|---------|------|
| Commerce manifest | `/.well-known/commerce.json` |
| Plain HTTP API | `/commerce/products` |
| MCP | `/mcp` |
| ACP | `/acp/feed` |
| UCP | `/.well-known/ucp` + `/api/catalog/*` |

Read-only by default — no PSP or keys required. Add checkout later with
`createCheckoutServer` + a PSP adapter (`stripePsp` / `referencePsp`).

!!! tip "Same config, every surface"
    `curl localhost:3000/acp/feed` and `POST localhost:3000/api/catalog/search`
    return the same offers as the HTTP API — emitted from the one `defineCommerce`
    config. That's the unification.

---

## Or: clone the example demo

Prefer to poke at a working multi-protocol shop with an LLM agent first?

**Prerequisites:** Node ≥ 20, pnpm ≥ 9, *(optional)* `ANTHROPIC_API_KEY` for the
LLM path of `@steelyard/agent` (without it, a naive parser still answers).

```bash
git clone https://github.com/steelyard-dev/steelyard-sdk.git steelyard
cd steelyard
pnpm install
pnpm -r build
pnpm --filter @steelyard/example-coffee-shop start   # → http://127.0.0.1:3000
```

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
    Re-run the command pointing at `/acp/feed` or `/.well-known/ucp`, or fetch
    `/commerce/products` directly. The returned offer list is emitted from the
    same config.

## What's next

- :material-cogs: Read about the [unification thesis](concepts/unification.md)
  and why three protocol surfaces from one config matters.
- :material-package: Drop `@steelyard/buyer/client` into your own agent runtime —
  see the [buyer SDK guide](packages/client.md).
- :material-tools: Build your own multi-protocol merchant — see
  [`defineCommerce`](concepts/define-commerce.md).
- :material-file-code: Generate static `commerce.json` — see the
  [static manifest guide](guides/static-manifest.md).
