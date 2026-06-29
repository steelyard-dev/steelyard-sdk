# Your First Purchase

This guide runs the coffee-shop example end to end with mock PSP and mock
mandate verification.

```bash
pnpm install
pnpm build

STEELYARD_ALLOW_MOCK_PSP=1 \
STEELYARD_ALLOW_MOCK_MANDATE=1 \
pnpm --filter steelyard-example-coffee-shop buy:real -- --protocol acp

STEELYARD_ALLOW_MOCK_PSP=1 \
STEELYARD_ALLOW_MOCK_MANDATE=1 \
pnpm --filter steelyard-example-coffee-shop buy:real -- --protocol ucp
```

Each command starts an in-process merchant checkout server, a separate mock
delegate-payment server, a temporary project wallet, and buys a cappuccino.
The output is a JSON receipt summary.

## Raw primitives

Power users can call the ACP driver directly:

```bash
STEELYARD_ALLOW_MOCK_PSP=1 \
STEELYARD_ALLOW_MOCK_MANDATE=1 \
pnpm --filter steelyard-example-coffee-shop buy:primitives:v03
```

That script intentionally skips the wallet policy engine and reservation
ledger. Use it for driver integration work, not normal buyer flows.
