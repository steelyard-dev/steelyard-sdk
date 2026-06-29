# HTTP Message Signatures

Steelyard v0.4.2 implements UCP HTTP Message Signatures for the UCP REST
checkout transport and streamable HTTP MCP. The implementation uses RFC 9421
`Signature-Input` and `Signature`, RFC 9530 `Content-Digest`, and RFC 8941
structured fields.

ACP is unchanged. UCP discovery is not signed because the discovery document is
where peers learn the public signing keys.

## Request Signatures

When HMS is selected for an outgoing UCP request, Steelyard signs the request
before it leaves the buyer driver or request sender. Signed requests include:

- `UCP-Agent`, formatted as an RFC 8941 dictionary such as
  `profile="https://wallet.example/.well-known/ucp"`.
- `Idempotency-Key` on mutating methods.
- `Content-Type` and `Content-Digest` when a body is present.
- `Signature-Input` and `Signature`.

The covered component set is fixed by UCP:

```text
@method
@authority
@path
@query          when the URL has a query string
ucp-agent
idempotency-key for POST, PUT, PATCH, and DELETE
content-digest  when a body is present
content-type    when a body is present
```

`@authority` is normalized from the target URL: lowercase host, default port
stripped, and no userinfo. `Content-Digest` is computed over the raw HTTP body
bytes. JSON canonicalization is not used for transport digests.

## Response Signatures

UCP response signatures use a different signature base from requests. They
cover `@status` and, when a body is present, `content-digest` and
`content-type`.

`steelyard/merchant/checkout` exposes:

```ts
responseSigningPolicy: "high-value-only" | "all" | "off"
```

The default, `high-value-only`, signs the UCP `complete_checkout` response when
the merchant has HMS signing keys configured. The buyer driver verifies signed
complete responses before returning the receipt. Low-value unsigned responses
remain valid.

## Signing Keys

Public signing keys live at the top level of the UCP profile:

```json
{
  "ucp": { "version": "2026-04-17" },
  "signing_keys": [
    { "kid": "merchant_2026", "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "use": "sig", "alg": "ES256" }
  ]
}
```

The private EC JWK field `d` must never appear in a profile, response, log, or
other wire surface. Steelyard strips it from discovery and buyer profile helper
output.

## Algorithms

UCP transport signatures support:

- `ES256` with `P-256`
- `ES384` with `P-384`

The ECDSA signature bytes are fixed-width raw `r || s`, not DER. Tests assert
64 bytes for ES256 and 96 bytes for ES384 so OpenSSL default changes cannot
silently alter the wire format.

## Profile Fetching

Verifiers resolve `Signature-Input` `keyid` values against the signer profile
advertised in `UCP-Agent`. Fetching is bounded:

- HTTPS only for public URLs.
- Loopback HTTP is allowed only when `allowPrivateNetwork: true` is set.
- Redirects are rejected.
- Profile bodies are capped at 1 MiB.
- Profiles are cached with a minimum TTL, and an unknown `kid` causes at most
  one forced refresh in the current TTL window.

See [Buyer HMS profile](../guides/buyer-hms-profile.md) and
[Key rotation](key-rotation.md) for operator setup.

## Error Shape

UCP signing failures use the UCP REST envelope:

```json
{ "code": "signature_invalid", "content": "Signature verification failed" }
```

`signature_missing`, `signature_invalid`, and `key_not_found` map to HTTP 401.
`digest_mismatch` and `algorithm_unsupported` map to HTTP 400.
