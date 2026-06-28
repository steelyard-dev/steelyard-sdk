# Payment Mandates

AP2 separates checkout authorization from payment authorization.
`ap2.checkout_mandate` proves that the user accepted the checkout terms, while
the payment mandate proves authorization for the funds transfer.

Steelyard v0.5 uses AP2-defined payment mandate semantics. It does not use the
older draft Steelyard composite token format.

## Placement

The checkout mandate is sent in the AP2 extension object:

```json
{
  "ap2": {
    "checkout_mandate": "<sd-jwt-kb>"
  }
}
```

The payment mandate is sent through the selected UCP `credential.token` field:

```json
{
  "payment": {
    "instruments": [
      {
        "id": "instr_1",
        "handler_id": "card",
        "selected": true,
        "credential": {
          "type": "ap2_payment_mandate",
          "token": "<sd-jwt-kb>"
        }
      }
    ]
  }
}
```

The token is an SD-JWT+KB presentation. The PSP adapter receives it with
`format: "ap2-sd-jwt-kb"`.

## Claims

Steelyard's AP2 payment mandate uses `vct: "mandate.payment.1"` and includes:

- `iss`, `iat`, `exp`, and `aud`
- `cnf.jwk`, bound to the buyer's AP2 holder key
- `transaction_id`
- `payee`
- `payment_amount`
- `payment_instrument`

The AP2 payment chain is the AP2 open/closed mandate model
(`mandate.payment.open.1` followed by `mandate.payment.1`). In UCP, Steelyard
binds the payment mandate to the locked checkout by deriving `transaction_id`
from `checkout.ap2.merchant_authorization`.

## Verification

The merchant verifies the checkout mandate before capture. The PSP adapter then
verifies the payment mandate before accepting the capture arguments:

- SD-JWT and KB-JWT shape
- `typ: "dc+sd-jwt"` on the issuer JWT
- `typ: "kb+jwt"` on the KB-JWT
- holder-key signature and `sd_hash`
- `vct: "mandate.payment.1"`
- expiration and issued-at time
- transaction id
- amount and currency

The payment mandate is not a vault token. It is a signed payment authorization
that may carry or reference a payment instrument depending on the handler.
