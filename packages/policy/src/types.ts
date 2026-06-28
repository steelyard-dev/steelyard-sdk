export type RailName = "virtual_card";

export type IntentType = "one_time" | "subscription" | "mandate" | "installment";

export type Provenance =
  | "agent_declared"
  | "manifest"
  | "manifest_priced"
  | "url_etld+1"
  | "tls_probe"
  | "fx_quote";

export interface Money {
  amount_minor: bigint;
  currency: string;
}

export interface Intent {
  merchant: { domain: string; name?: string; commerce_manifest_url?: string };
  amount: Money;
  type: IntentType;
  cart?: { items: Array<{ sku?: string; sku_class?: string; quantity: number; price_minor: bigint }> };
  agent_rationale?: string;
  purchase_id?: string;
}

export interface PolicyDocument {
  version: string;
  trusted_domains?: Record<string, string[]>;
  blocked_domains?: string[];
  rules: Rule[];
}

export type RuleEffect = "allow" | "deny" | "require_approval";

export interface Rule {
  name: string;
  do: RuleEffect;
  rail?: RailName;
  when?: Record<string, unknown>;
  limits?: { per_day_usd?: number; per_day_count?: number; per_purchase_usd?: number };
  approval?: {
    who: "user";
    channel: "webhook";
    expires_in: string;
    include_in_prompt?: string[];
  };
}
