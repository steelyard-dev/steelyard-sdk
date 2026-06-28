import { parse as parseDomain } from "tldts";
import type { FxQuote, FxQuoteService } from "./fx.js";
import { mulRate } from "./money.js";
import type { Intent, IntentType, Money, Provenance } from "./types.js";

export interface Tagged<T> {
  value: T;
  source: Provenance;
}

export interface NormalizedFacts {
  merchant_domain: Tagged<string>;
  amount_usd: Tagged<Money>;
  type: Tagged<IntentType>;
  cart_contains: Tagged<string[]>;
  merchant_supports_ucp_acp: Tagged<boolean>;
  tls_ok: Tagged<boolean>;
  fx_quote_id?: string;
  fx_quote?: Pick<FxQuote, "id" | "ts">;
  untrusted_agent_text: { agent_rationale?: string };
}

export async function normalizeFacts(args: { intent: Intent; fx: FxQuoteService }): Promise<NormalizedFacts> {
  const { intent, fx } = args;
  const merchantDomain = normalizeMerchantDomain(intent);
  const amount = await normalizeAmountUsd(intent, fx);

  return {
    merchant_domain: merchantDomain,
    amount_usd: amount.amount_usd,
    type: { value: intent.type, source: "agent_declared" },
    cart_contains: { value: cartClasses(intent), source: "agent_declared" },
    merchant_supports_ucp_acp: { value: false, source: "manifest" },
    tls_ok: { value: tlsOk(intent), source: "tls_probe" },
    fx_quote_id: amount.fx_quote?.id,
    fx_quote: amount.fx_quote ? { id: amount.fx_quote.id, ts: amount.fx_quote.ts } : undefined,
    untrusted_agent_text: { agent_rationale: intent.agent_rationale }
  };
}

function normalizeMerchantDomain(intent: Intent): Tagged<string> {
  if (intent.merchant.commerce_manifest_url) {
    return { value: intent.merchant.domain.toLowerCase(), source: "manifest" };
  }
  return { value: etldPlus1(intent.merchant.domain), source: "url_etld+1" };
}

async function normalizeAmountUsd(
  intent: Intent,
  fx: FxQuoteService
): Promise<{ amount_usd: Tagged<Money>; fx_quote?: FxQuote }> {
  const currency = intent.amount.currency.toUpperCase();
  if (currency === "USD") {
    return {
      amount_usd: { value: { amount_minor: intent.amount.amount_minor, currency: "USD" }, source: "agent_declared" }
    };
  }

  const quote = await fx.quote(currency, "USD");
  return {
    amount_usd: {
      value: mulRate(intent.amount.amount_minor, currency, quote.rate, "USD"),
      source: "fx_quote"
    },
    fx_quote: quote
  };
}

function tlsOk(intent: Intent): boolean {
  const url = intent.merchant.commerce_manifest_url;
  return url === undefined || url.startsWith("https://");
}

function etldPlus1(host: string): string {
  const parsed = parseDomain(host);
  return parsed.domain?.toLowerCase() ?? host.toLowerCase();
}

function cartClasses(intent: Intent): string[] {
  return Array.from(new Set((intent.cart?.items ?? []).map((item) => item.sku_class).filter((value): value is string => Boolean(value))));
}
