import { Steelyard, verifyAcpWebhook } from "@steelyard/buyer/client";
import { ACP_API_VERSION_HEADER, ACP_VERSION, ACP_WEBHOOK_SIGNATURE_HEADER, signAcpWebhook } from "@steelyard/protocol/acp";
import {
  assertStripeReceipt,
  installFetchRecorder,
  intentFromOffer,
  isMerchant,
  json,
  record,
  startStripeSmokeHarness,
  stripeSmokeAcpBearerToken,
  stripeSmokeConfigOrSkip
} from "./stripe-smoke-common.js";

const config = stripeSmokeConfigOrSkip();
if (!config) process.exit(0);

const harness = await startStripeSmokeHarness(config, { acpBearerToken: stripeSmokeAcpBearerToken });
const recorder = installFetchRecorder(harness.shop.baseUrl);
try {
  const discovery = await json(`${harness.shop.baseUrl}/.well-known/acp.json`);
  if (discovery.api_base_url !== `${harness.shop.baseUrl}/acp`) {
    throw new Error(`ACP discovery api_base_url mismatch: ${JSON.stringify(discovery)}`);
  }

  const merchant = await Steelyard.connect(`${harness.shop.baseUrl}/.well-known/acp.json`, {
    acpAuth: { bearerToken: stripeSmokeAcpBearerToken }
  });
  if (!isMerchant(merchant)) throw new Error(`ACP connect failed: ${JSON.stringify(merchant)}`);

  const offer = await merchant.getOffer("single");
  if ("error" in offer) throw new Error(offer.error_detail ?? offer.error);
  const receipt = await harness.wallet.pay(intentFromOffer(offer, merchant.url, "acp"), {
    merchant,
    idempotencyKey: `coffee_stripe_acp_${Date.now().toString(36)}`
  });
  assertStripeReceipt(receipt, "acp", harness.captures.at(-1));
  assertAcpRequestTrace(recorder.requests);
  await assertWebhookVerification();

  console.log(JSON.stringify({
    ok: true,
    mock_stripe: config.mockStripe,
    protocol: receipt.protocol,
    order_id: receipt.order_id,
    status: receipt.status,
    charged_amount: receipt.charged_amount,
    charged_currency: receipt.charged_currency,
    reference: receipt.reference.acp,
    psp_capture: harness.captures.at(-1)
  }, null, 2));
} finally {
  recorder.restore();
  await harness.cleanup();
}

function assertAcpRequestTrace(requests: { method: string; path: string; headers: Record<string, string>; body?: unknown }[]): void {
  if (!requests.some((request) => request.method === "GET" && request.path === "/.well-known/acp.json")) {
    throw new Error("ACP smoke did not resolve /.well-known/acp.json");
  }
  if (!requests.some((request) => request.method === "POST" && request.path === "/acp/checkout_sessions")) {
    throw new Error("ACP smoke did not create a checkout_session");
  }
  if (requests.some((request) => request.path.includes("delegate_payment"))) {
    throw new Error("ACP smoke unexpectedly called delegate_payment");
  }
  const complete = requests.find((request) =>
    request.method === "POST"
    && /^\/acp\/checkout_sessions\/[^/]+\/complete$/.test(request.path)
  );
  if (!complete) throw new Error("ACP smoke did not complete a checkout_session");
  if (complete.headers[ACP_API_VERSION_HEADER.toLowerCase()] !== ACP_VERSION) {
    throw new Error("ACP complete request did not carry API-Version");
  }
  const paymentData = record(record(complete.body).payment_data);
  const instrument = record(paymentData.instrument);
  const credential = record(instrument.credential);
  if (paymentData.handler_id !== "stripe" || instrument.type !== "card") {
    throw new Error(`ACP complete payment_data had wrong handler/instrument: ${JSON.stringify(paymentData)}`);
  }
  if (credential.type !== "spt" || !/^spt_[A-Za-z0-9]+$/.test(String(credential.token ?? ""))) {
    throw new Error(`ACP complete payment_data had wrong credential: ${JSON.stringify(paymentData)}`);
  }
}

async function assertWebhookVerification(): Promise<void> {
  const rawBody = JSON.stringify({ id: "evt_coffee_smoke", type: "checkout_session.completed" });
  const now = new Date();
  const secret = "whsec_coffee_smoke";
  const signature = await signAcpWebhook({ rawBody, secret, timestamp: now });
  const verified = await verifyAcpWebhook({
    rawBody,
    secret,
    headers: { [ACP_WEBHOOK_SIGNATURE_HEADER]: signature },
    now
  });
  if (!verified.ok) throw new Error(`ACP webhook signature did not verify: ${JSON.stringify(verified)}`);
}
