# Stripe SPT Errors

Steelyard normalizes Stripe Shared Payment Token failures into existing PSP
result shapes where possible. The merchant checkout boundary then maps those
results into ACP or UCP protocol errors.

| Stripe condition | Steelyard result | Notes |
| --- | --- | --- |
| `spt_expired` | `failure_reason: "spt_expired"` | Token was outside its usage window. |
| `spt_max_amount_exceeded` | `failure_reason: "amount_exceeded"` | Requested capture exceeded the SPT usage limit. |
| `spt_revoked` | `failure_reason: "spt_revoked"` | Buyer or issuer revoked the SPT. |
| `spt_seller_mismatch` | `failure_reason: "spt_seller_mismatch"` | SPT was minted for a different seller profile. |
| `requires_authentication` | `requires_authentication` with `continue_url` | Preserves the existing 3DS/escalation path. |
| `card_declined` | `failure_reason: "declined"` | Same handling as the v0.4 PaymentMethod path. |
| `expired_card` | `failure_reason: "expired_card"` | Same handling as the v0.4 PaymentMethod path. |
| `insufficient_funds` | `failure_reason: "insufficient_funds"` | Same handling as the v0.4 PaymentMethod path. |
| Unknown Stripe error | `failure_reason: "other"` | The message is redacted before surfacing. |

SPT minting errors throw `StripeSptMintError`; SPT charge errors return a PSP
failure result when Stripe returns a structured payment error, or throw
`StripeSptChargeError` for transport and malformed-response failures. Stripe
secret keys are redacted from thrown messages.

In v0.6 all SPT paths require `sk_test_*`. `sk_live_*` fails immediately with
`STRIPE_LIVE_DISABLED_v0_6`.
