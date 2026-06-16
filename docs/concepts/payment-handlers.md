# Payment Handlers

UCP payment handlers let a merchant advertise payment rails independently from
catalog and checkout capabilities. Steelyard v0.6 publishes Stripe as the first
handler under the `net.steelyard` reverse-domain namespace.

The registry lives inside the UCP object as `ucp.payment_handlers`. It is not a
top-level array. The vendored schema at
`packages/protocol/spec/ucp/2026-04-17/schemas/ucp.json` defines it as an
object keyed by reverse-domain namespace; each value is an array of handler
entries.

```json
{
  "ucp": {
    "version": "2026-04-17",
    "services": {},
    "capabilities": {},
    "payment_handlers": {
      "net.steelyard": [
        {
          "id": "stripe",
          "available_instruments": [
            { "type": "card", "constraints": { "brands": ["visa", "mastercard", "amex"] } },
            { "type": "shared_payment_token" }
          ]
        }
      ]
    }
  }
}
```

`shared_payment_token` is the Steelyard v0.6 instrument type for Stripe SPTs.
The buyer flattens all namespaces into `merchant.paymentHandlers`, picks the
first compatible handler for its `paymentIssuer`, and records the selected
handler id in the AP2 payment mandate claim `payment.handler`.

Future handlers such as Adyen or Checkout.com should publish under their own
reverse-domain namespaces rather than `net.steelyard`.

Developer note: Steelyard v0.6 depends on the upstream UCP JS SDK package
`@ucp-js/sdk` for compatible generated types. Some discovery and catalog shapes
remain local because `@ucp-js/sdk@0.1.0` does not yet match the vendored
2026-04-17 object-keyed profile schema.
