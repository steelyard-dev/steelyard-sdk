# @steelyard/example-nextjs

A Next.js 15 App Router demo: human Stripe Checkout for visitors, agent
discovery + (optionally) agent checkout via Steelyard from the same app.

## Run

```sh
pnpm install
echo "STRIPE_SECRET_KEY=sk_test_..." > .env.local
pnpm dev
```

Visit:

- `http://localhost:3000` — the shop
- `http://localhost:3000/__steelyard` — the dev inspector
- `http://localhost:3000/.well-known/commerce.json` — agent discovery

## Upgrade to agent checkout

```sh
node ../../packages/cli/dist/cli.js enable checkout --yes
```
