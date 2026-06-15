# AP2 Mandates

This module issues UCP AP2 mandate values as SD-JWT+KB presentations:

- `ap2.checkout_mandate` for the checkout authorization.
- `payment.instruments[*].credential.token` for the AP2 payment mandate.

Library choice for v0.5 is pinned to OpenWallet Foundation
`@sd-jwt/core@^0.19.0` and `@sd-jwt/sd-jwt-vc@^0.19.0` (Apache-2.0).
`@sd-jwt/core` is used for the checkout mandate issuer because the UCP AP2
checkout mandate payload does not carry an SD-JWT-VC `vct` claim. The AP2
payment mandate does carry `vct: "mandate.payment.1"` and is bound to the UCP
checkout by hashing the checkout's `ap2.merchant_authorization` detached JWS as
Steelyard's UCP adapter for AP2's checkout-JWT transaction hash. `jose` is not
used for this layer because it does not provide SD-JWT selective disclosure or
KB-JWT presentation assembly.

The issuer signs both the SD-JWT and KB-JWT with the vault UCP signing key. The
KB-JWT `sd_hash` is computed over the SD-JWT presentation bytes including the
trailing `~` separator before the KB-JWT, matching RFC 9901 section 4.3 and the
v0.5 GOAL.md NF4 correction.
