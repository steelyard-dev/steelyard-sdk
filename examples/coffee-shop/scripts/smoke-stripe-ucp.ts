import { Steelyard } from "@steelyard/buyer/client";
import {
  assertStripeReceipt,
  assertUcpStripeHandler,
  intentFromOffer,
  isMerchant,
  json,
  startStripeSmokeHarness,
  stripeSmokeConfigOrSkip,
  stripeSmokeIssuer
} from "./stripe-smoke-common.js";

const config = stripeSmokeConfigOrSkip();
if (!config) process.exit(0);

const harness = await startStripeSmokeHarness(config);
try {
  const discovery = await json(`${harness.shop.baseUrl}/.well-known/ucp`);
  assertUcpStripeHandler(discovery);

  const merchant = await Steelyard.connect(`${harness.shop.baseUrl}/.well-known/ucp`, {
    allowPrivateNetwork: true,
    ucpAuth: {
      preferred: "hms",
      signing: {
        kid: harness.signingKid,
        algorithm: "ES256",
        profileUrl: `${harness.shop.baseUrl}/buyer/.well-known/ucp`
      }
    },
    ap2: {
      enabled: true,
      issuer: stripeSmokeIssuer,
      payee: {
        id: "coffee.example",
        name: "Coffee Shop",
        website: harness.shop.baseUrl
      }
    }
  });
  if (!isMerchant(merchant)) throw new Error(`UCP connect failed: ${JSON.stringify(merchant)}`);
  if (!merchant.supports("checkout:ap2")) throw new Error("UCP merchant did not AP2-lock the Stripe smoke session");

  const offer = await merchant.getOffer("single");
  if ("error" in offer) throw new Error(offer.error_detail ?? offer.error);
  const receipt = await harness.wallet.purchase(intentFromOffer(offer, merchant.url, "ucp"), {
    merchant,
    idempotencyKey: `coffee_stripe_ucp_${Date.now().toString(36)}`
  });
  assertStripeReceipt(receipt, "ucp");

  console.log(JSON.stringify({
    ok: true,
    mock_stripe: config.mockStripe,
    protocol: receipt.protocol,
    order_id: receipt.order_id,
    status: receipt.status,
    charged_amount: receipt.charged_amount,
    charged_currency: receipt.charged_currency,
    reference: receipt.reference.ucp
  }, null, 2));
} finally {
  await harness.cleanup();
}
