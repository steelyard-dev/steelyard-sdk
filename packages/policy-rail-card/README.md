# steelyard/policy-rail-card

Stripe Issuing virtual-card policy rail adapter for `steelyard/policy`.

## Stripe Issuing Prerequisites

You need:

- a Stripe account with Issuing enabled
- a test or live Issuing cardholder id
- an API key that can create and update Issuing cards
- webhook delivery for Issuing authorization, transaction, and card update
  events

For restricted keys, grant the smallest set that covers Issuing card create,
Issuing card update/cancel, and read access for Issuing authorization and
transaction objects used by your webhook receiver. The env-gated sandbox test
also uses Stripe Issuing test helpers, so test keys need access to
`test_helpers.issuing`.

## Sandbox and Production

The rail is constructed with an explicit `env` tag:

```ts
import { virtualCardRail } from "steelyard/policy-rail-card";

const rail = virtualCardRail({
  stripe,
  cardholderId: process.env.STRIPE_ISSUING_CARDHOLDER!,
  env: "sandbox",
  webhookBus
});
```

The policy engine refuses to mint when an intent environment and rail adapter
environment do not match. Use separate data directories, Stripe keys, and
cardholder ids for sandbox and production.

The adapter boundary converts Stripe Issuing concepts into the policy engine's
`PolicyRailAdapter` contract: `mint`, `observe`, `revoke`, and
`ackSettlement`.

## Caveats

```text
amount + expiry hard; MCC soft (issuer-honored, merchant-categorized); MID best-effort (depends on aggregator routing and descriptor).
```

In practical terms, the loss ceiling is per credential, but merchant identity
is not PSP-attested by this package. MID locking is rejected when requested
because the adapter cannot guarantee it across aggregators and descriptors.

## Webhook Setup

Route Stripe Issuing webhooks through your HTTP server, verify Stripe's
signature there, then ingest the normalized event into the bus used by the
adapter:

```ts
import Stripe from "stripe";
import { virtualCardRail, WebhookEventBus } from "steelyard/policy-rail-card";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookBus = new WebhookEventBus();
const rail = virtualCardRail({
  stripe,
  cardholderId: process.env.STRIPE_ISSUING_CARDHOLDER!,
  env: "production",
  webhookBus
});

app.post("/stripe/webhook", rawBodyMiddleware, (req, res) => {
  const event = stripe.webhooks.constructEvent(
    req.body,
    req.header("stripe-signature")!,
    process.env.STRIPE_WEBHOOK_SECRET!
  );

  if (
    event.type === "issuing_authorization.request" ||
    event.type === "issuing_authorization.created" ||
    event.type === "issuing_transaction.created" ||
    event.type === "issuing_card.updated"
  ) {
    webhookBus.ingest(event);
  }

  res.sendStatus(204);
});
```

`observe(credential_id)` reads from the same bus, dedupes by Stripe event id,
and yields settlement events in monotonic `created` order.
