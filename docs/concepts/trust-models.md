# Trust Models

Steelyard v0.5 uses the AP2 Digital Payment Credential trust model.

That means merchants do not treat an arbitrary local wallet key as a trusted
platform key. The buyer's holder key must be bound to a credential issued by a
source the merchant trusts, such as a bank, network, or DPC issuer.

## Digital Payment Credential

AP2's Digital Payment Credential model expects a wallet presentation flow such
as OpenID4VP. The wallet proves possession of the private key associated with
the credential, and the merchant verifies the issuer and key binding.

In v0.5, Steelyard exposes the trust decision as merchant verifier
configuration:

```ts
sdJwtKbVerifier({
  trustModel: {
    kind: "digital_payment_credential",
    resolveIssuerKey: async ({ issuer, kid, alg, claims }) => {
      return await lookupTrustedPaymentCredentialIssuerKey({ issuer, kid, alg, claims });
    }
  },
  expectedAudience: (checkout) => "https://coffee.example/.well-known/ucp",
  nonceStore,
  merchantSigningKeys
});
```

The resolver returns the trusted issuer public key for the SD-JWT issuer JWT.
Returning `null` maps to `agent_missing_key`.

## Out Of Scope In v0.5

v0.5 does not ship a full OpenID4VP server-initiated presentation service or a
payment mandate issuer integration. Production deployments must provide their
own issuer trust resolver and mandate issuance path.

The coffee-shop example uses a configured demo issuer key so the AP2 smoke test
can run end to end. That is a fixture trust setup, not a general production
trust framework.

## Key Reuse

The AP2 holder key is the buyer UCP signing key created by the encrypted vault:

```ts
await wallet.createUcpSigningKey({ algorithm: "ES256" });
const publicKey = await wallet.exportUcpSigningPublicKey();
```

For new wallets, the default `Wallet.create()` mandate-key setup provisions the
legacy Steelyard mandate key and the ES256 UCP signing key. Use
`mandateKey: false` only when you want to skip both default mandate keys and
create them later.

Publish only the public JWK in the buyer HMS/AP2 profile. Never publish a
private JWK `d` value.
