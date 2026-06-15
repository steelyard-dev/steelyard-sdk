# AP2 Checkout Mandates

This module issues UCP AP2 `ap2.checkout_mandate` values as SD-JWT+KB
presentations.

Library choice for v0.5 is pinned to OpenWallet Foundation
`@sd-jwt/core@^0.19.0` and `@sd-jwt/sd-jwt-vc@^0.19.0` (Apache-2.0).
`@sd-jwt/core` is used for the checkout mandate issuer because the UCP AP2
checkout mandate payload does not carry an SD-JWT-VC `vct` claim. The
`@sd-jwt/sd-jwt-vc` package is still kept as the companion SD-JWT-VC package
for AP2 payment-mandate work. `jose` is not used for this layer because it
does not provide SD-JWT selective disclosure or KB-JWT presentation assembly.

The issuer signs both the SD-JWT and KB-JWT with the vault UCP signing key. The
KB-JWT `sd_hash` is computed over the SD-JWT presentation bytes including the
trailing `~` separator before the KB-JWT, matching RFC 9901 section 4.3 and the
v0.5 GOAL.md NF4 correction.
