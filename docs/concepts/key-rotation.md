# Key Rotation

UCP HTTP Message Signatures use top-level profile `signing_keys[]` for public
key discovery. The private JWK, including `d`, stays in the signer vault or
server configuration. Profiles publish only public fields: `kid`, `kty`, `crv`,
`x`, `y`, `use`, and `alg`.

## Merchant Rotation

Merchants configure one or more ES256 or ES384 keys and choose one `activeKid`.
Steelyard signs outgoing UCP checkout responses with only the active key.

Keep the previous public key in `signing_keys[]` for at least seven days after
changing `activeKid`. Peers may have cached a response signed by the old kid and
need to refetch your profile to resolve it.

Do not use the merchant's own key set to verify incoming requests. Incoming UCP
signatures are verified against the peer profile resolved from that request's
`UCP-Agent` header.

## Buyer Rotation

Buyers follow the same public-profile pattern. Publish the old and new public
keys in the buyer HMS profile, move request signing to the new `kid`, then keep
the retired public key available for at least seven days.

The encrypted wallet vault owns the private key. Operators should expose only
the output of `wallet.exportUcpSigningPublicKey()` through
`createUcpBuyerProfile()` or equivalent static JSON.

## Operator Checklist

1. Generate a new P-256 or P-384 signing key.
2. Publish the new public key alongside the old key in `signing_keys[]`.
3. Move outgoing signing to the new `kid`.
4. Keep both public keys published for at least seven days.
5. Remove the retired private key only after that grace period has elapsed.

If a verifier sees an unknown `kid`, Steelyard performs one forced profile
refresh in the current cache window before returning `key_not_found`.
