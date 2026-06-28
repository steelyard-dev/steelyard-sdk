# Policy Engine

The policy engine is the buyer-side process that gates LLM-proposed payments
before a rail credential exists. The agent proposes an intent; the engine
normalizes facts, evaluates YAML policy, reserves budget, and mints the
narrowest credential the selected rail can enforce.

The v1 release is card-only. The virtual-card rail uses Stripe Issuing and
returns single-use card credentials. VRP and UCP/ACP rails are deferred until
their enforcement semantics can be represented without pretending they are
equivalent to network-enforced cards.

## Why It Exists

The LLM agent never receives Stripe, bank, or protocol signing credentials. It
talks to the policy engine over local IPC and receives only a credential scoped
to the approved payment. If the agent is hijacked, the useful secret it can get
is the minted credential, not the underlying rail authority.

That boundary is process isolation, not a security sandbox. The Unix socket is
created under `$STEELYARD_DATA_DIR/policy.sock` with mode `0600`, and the
engine requires a `caller_token` generated at startup in
`$STEELYARD_DATA_DIR/caller.token`. Where the Node runtime exposes peer
credentials, the engine also checks same-uid peers; otherwise it documents the
weaker filesystem-token fallback.

## Running the Policy Engine

Policy defaults to `~/.steelyard/policy.yaml`, and data defaults to
`~/.steelyard`:

```bash
steelyard policy lint ~/.steelyard/policy.yaml
steelyard policy run --policy ~/.steelyard/policy.yaml --data-dir ~/.steelyard
```

The foreground process prints the data directory, socket path, and caller
token. `SIGHUP` reloads the policy atomically for future intents; in-flight
intents keep their original policy snapshot.

## Authorization Binding

Every allow or approval decision has an `authorization_hash`. The hash is over
canonical JSON containing:

- `policy_hash`
- `rule_name`
- `rail`
- `credential_constraints`
- `approval_prompt_hash`
- `fx_quote: { id, ts }`
- `rail_native: { amount_minor, currency }`
- `normalized_facts`

The rail adapter receives the constraints unchanged. If a returned credential
does not carry the expected `authorization_hash`, the engine refuses it. Later
approvals, minting, credential records, and settlement observations refer back
to the same hash.

## YAML Policy Shape

Policies are ordered rule lists. Deny rules always win; otherwise the first
matching allow or approval rule is used.

```yaml
version: 2026-06-27
trusted_domains:
  retail:
    - example.com
rules:
  - name: small-retail
    do: allow
    rail: virtual_card
    when:
      merchant_domain_in: retail
      amount_usd: { max: 25 }
      type: one_time
    limits:
      per_day_usd: 100
      per_day_count: 5
  - name: deny-all
    do: deny
```

`cart_contains` is only as strong as the supplied cart facts. `tls: required`
checks HTTPS manifest URLs; it is not PSP-attested merchant identity.
`merchant_signature: verified` is not reachable on the v1 card rail and emits
a load-time warning.

## Card Rail Caveats

The Stripe Issuing adapter reports:

```text
amount + expiry hard; MCC soft (issuer-honored, merchant-categorized); MID best-effort (depends on aggregator routing and descriptor).
```

The adapter rejects requested MID locks because the package cannot guarantee
that the processor descriptor or aggregator route maps to the merchant the
policy author intended. Treat amount and expiry as the hard loss ceiling; treat
MCC and merchant identity predicates as weaker signals.

## Approval Flow

`require_approval` rules send an HMAC-signed webhook prompt. The prompt
contains engine-composed payment facts, nonce, policy hash, authorization hash,
and expiry. Agent text is recorded separately as untrusted rationale so an
approval UI can label it appropriately.

Callbacks must present the same nonce and HMAC signature. Replays, expired
prompts, stale policy hashes after reload, and cancelled intents are rejected
with defined status codes and audit entries.

## Audit Log

Audit files are written as JSONL under:

```text
$STEELYARD_DATA_DIR/audit/YYYY-MM-DD.jsonl
```

Each entry includes the decision, matched rule, counterfactuals, normalized
facts, policy hash, authorization hash, credential id when present, limits
after evaluation, untrusted agent text, and hash-chain fields. Settlement
events are appended as amendment entries using `amends`; prior log lines are
never edited in place.

Verify the local chain with:

```bash
steelyard policy audit verify ~/.steelyard
```

The verifier detects local edits if it has a trusted head hash. Without an
external checkpoint, the JSONL chain is an operational ledger and debugging
tool, not a tamper-evident defense against an attacker who can rewrite both the
log and the verifier's starting point.
