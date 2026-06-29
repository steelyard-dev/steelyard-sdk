# Buyer HMS Profile

An HMS buyer must publish a UCP profile so merchants can resolve the buyer's
public signing key. Steelyard signs buyer requests with the encrypted wallet
vault key and advertises this profile URL in the `UCP-Agent` header.

The profile contains public signing material only:

```json
{
  "ucp": { "version": "2026-04-17" },
  "signing_keys": [
    { "kid": "wallet_2026", "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "use": "sig", "alg": "ES256" }
  ]
}
```

Do not include the private JWK `d` field. `createUcpBuyerProfile()` validates
and strips profile output to public EC fields.

## Generate The Profile

```ts
import { Wallet } from "steelyard/buyer";
import { createUcpBuyerProfile } from "steelyard/buyer/client";

const wallet = await Wallet.open();
if (!(await wallet.hasUcpSigningKey())) {
  await wallet.createUcpSigningKey({ algorithm: "ES256" });
}

const publicKey = await wallet.exportUcpSigningPublicKey();
const profile = createUcpBuyerProfile({ signingKeys: [publicKey] });
```

You can serve `profile` from a static file, CDN, cloud function, or a route in
your wallet service.

## Node Handler

For local development or a small wallet service, use the built-in handler:

```ts
import { createServer } from "node:http";
import { Wallet } from "steelyard/buyer";
import { createUcpBuyerProfileHandler } from "steelyard/buyer/client";

const wallet = await Wallet.open();
const publicKey = await wallet.exportUcpSigningPublicKey();

createServer(createUcpBuyerProfileHandler({
  signingKeys: [publicKey]
})).listen(3000);
```

The handler accepts `GET`, returns JSON, sets `Cache-Control: public, max-age=60`,
and returns 405 for other methods.

## Connect With The Profile

Pass the profile URL with the same `kid` and algorithm stored in the wallet:

```ts
import { Steelyard } from "steelyard/buyer/client";

const merchant = await Steelyard.connect("https://coffee.example/.well-known/ucp", {
  ucpAuth: {
    preferred: "hms",
    signing: {
      kid: publicKey.kid,
      algorithm: publicKey.alg === "ES384" ? "ES384" : "ES256",
      profileUrl: "https://wallet.example/.well-known/ucp"
    }
  }
});
```

For loopback demos, set `allowPrivateNetwork: true` and use
`http://127.0.0.1` or `http://localhost`. Production profiles should use HTTPS.

## Rotation Checklist

1. Create a new UCP signing key in the wallet vault.
2. Publish the old and new public keys in `signing_keys[]`.
3. Move buyers to the new `kid`.
4. Keep the old public key published for at least seven days.
5. Remove the old key only after peers have had time to refresh cached profiles.
