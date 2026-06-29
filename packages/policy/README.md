# steelyard/policy

Buyer-side policy engine for agent-initiated payments. The engine runs outside
the LLM agent, evaluates a YAML policy, reserves budget in SQLite, mints narrow
rail credentials through registered adapters, and writes an operational audit
log for every decision.

## Install

```bash
pnpm add steelyard
```

The package ships ESM and TypeScript declarations. Use
`steelyard/policy-rail-card` when you want the v1 Stripe Issuing rail.

## Quick start

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine, InMemoryFxQuoteService, type PolicyRailAdapter } from "steelyard/policy";

const clock = { now: () => new Date() };
const rail: PolicyRailAdapter = {
  name: "virtual_card",
  enforcement_level: "network_enforced",
  loss_ceiling_source: "per_credential",
  caveats: ["test rail"],
  env: "sandbox",
  capabilities: () => ({ rails_supported: ["virtual_card"], availability_signal_source: "test" }),
  mint: async ({ authorization_hash, constraints }) => ({
    credential_id: "rail_card_1",
    authorization_hash,
    rail: "virtual_card",
    payload: { pan: "4242424242424242" },
    expires_at: constraints.expires_at
  }),
  observe: async function* () {},
  revoke: async () => {},
  ackSettlement: async () => {}
};
const engine = new PolicyEngine({
  dataDir: mkdtempSync(join(tmpdir(), "policy-")),
  clock,
  fx: new InMemoryFxQuoteService({}, clock.now),
  rails: [rail],
  policyYaml: `version: 2026-06-27
trusted_domains: { shops: [example.com] }
rules:
  - name: shops-under-10
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: shops, amount_usd: { max: 10 } }
  - name: deny-all
    do: deny`
});
await engine.start();
const decision = await engine.proposeIntent({
  caller_token: engine.callerToken(),
  idempotency_key: "demo-1",
  intent: { merchant: { domain: "example.com" }, amount: { amount_minor: 500n, currency: "USD" }, type: "one_time" }
});
console.assert(decision.decision === "allow");
await engine.stop();
```

## YAML Reference

Policy files are validated by
`packages/policy/spec/policy/0.1/policy.schema.json`.

- `version`: required policy version. v1 accepts `2026-06-27`.
- `trusted_domains`: optional named domain lists. Rules reference a list by
  name with `when.merchant_domain_in`.
- `blocked_domains`: optional deny-list of hostnames. Rules can reference it
  with `merchant_domain_in: blocked_domains`.
- `rules`: required ordered rule list. Evaluation is first-match-wins for
  allows and approvals; deny rules always win.

Rule fields:

- `name`: required non-empty rule identifier used in decisions, counters, and
  audit entries.
- `do`: required effect, one of `allow`, `deny`, or `require_approval`.
- `rail`: required for `allow`; v1 accepts only `virtual_card`.
- `when`: optional predicate object. Missing `when` means the rule matches.
- `limits`: optional budget limits applied through the reservation ledger.
- `approval`: required only for `require_approval` rules.

`when` fields:

- `merchant_domain_in`: name of a `trusted_domains` list.
- `amount_usd.min` and `amount_usd.max`: inclusive USD major-unit bounds after
  engine-owned FX conversion.
- `type`: one intent type or a non-empty list of intent types:
  `one_time`, `subscription`, `mandate`, or `installment`.
- `cart_contains`: non-empty list of SKU classes. This is weak v1 evidence
  derived from supplied intent cart facts; it is forbidden on `deny`.
- `merchant_supports`: accepts `ucp_acp`, but the card rail does not make this
  true in v1.
- `merchant_signature`: accepts `verified`, but emits a load warning because
  the v1 card rail cannot verify merchant signatures.
- `tls`: accepts `required`. In v1 this checks that any commerce manifest URL
  is HTTPS; it is not PSP-attested merchant identity.

`limits` fields:

- `per_day_usd`: rolling 24-hour USD cap for a rule.
- `per_day_count`: rolling 24-hour count cap for a rule.
- `per_purchase_usd`: aggregate USD cap across intents sharing `purchase_id`.

`approval` fields:

- `who`: currently `user`.
- `channel`: currently `webhook`.
- `expires_in`: duration such as `30s`, `5m`, or `1h`.
- `include_in_prompt`: optional field names for the approval surface.

## Concepts

`authorization_hash` binds the policy snapshot, matched rule, rail,
credential constraints, approval prompt hash, FX quote, rail-native amount, and
normalized facts. A rail credential returned for a different hash is rejected.

Policy snapshots are immutable. Reloading the policy swaps in a new snapshot
for future intents; in-flight approvals and unsettled credentials keep their
original snapshot until they finish.

The reservation ledger uses SQLite WAL and transactional reservations to make
per-rule counters atomic. A reservation is committed when a credential is
minted or released when the intent is denied, cancelled, or expires.

The audit log is JSONL under `$STEELYARD_DATA_DIR/audit/`. It is an operational
ledger with a hash chain and amendment entries; it is not a tamper-evident
security boundary unless you publish trusted external checkpoints.

## What v1 Does Not Do

v1 is scoped to buyer-side virtual-card credential brokering. It does not ship
VRP, UCP/ACP rail enforcement, signed policy files, multi-tenant policy
isolation, push approvals, hardware-key approval, ACH/PayPal rails, or ML
scoring. The boundaries are intentional: the abstraction exposes rail caveats
instead of pretending every rail has the same enforcement strength.
