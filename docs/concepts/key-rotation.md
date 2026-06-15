# Key rotation

UCP HTTP Message Signatures use the merchant's own signing key set for outgoing
messages. Configure one or more ES256 or ES384 keys and choose one `activeKid`.
Steelyard signs outgoing UCP responses and webhooks with only the active key.

The full private JWK, including `d`, stays in server configuration. The UCP
profile publishes only public JWK fields in top-level `signing_keys[]`:
`kid`, `kty`, `crv`, `x`, `y`, `use`, and `alg`.

## Rotation window

Keep the previous public key in `signing_keys[]` for at least seven days after
changing `activeKid`. Peers may have cached a response signed by the old kid and
need to refetch your profile to resolve it.

Do not use the merchant's own key set to verify incoming requests. Incoming UCP
signatures are verified against the peer profile resolved from that request's
`UCP-Agent` header.

## Operator checklist

1. Generate a new P-256 or P-384 signing key.
2. Add it to `ucp.auth.hms.signingKeys` while keeping the old key.
3. Change `activeKid` to the new key.
4. Keep both public keys published in `signing_keys[]` for at least seven days.
5. Remove the retired private key only after that grace period has elapsed.
