import type { CredentialConstraints } from "../auth-hash.js";
import type { Intent, RailName } from "../types.js";

export type EnforcementLevel = "network_enforced" | "bank_enforced" | "merchant_enforced" | "engine_enforced_only";
export type LossCeilingSource = "per_credential" | "mandate_cap" | "engine_counters_only";
export type RailEnvironment = "sandbox" | "production";

export interface IssuedCredential {
  credential_id: string;
  authorization_hash: string;
  rail: RailName;
  payload: unknown;
  expires_at: string;
}

export type SettlementEventKind = "authorized" | "captured" | "refunded" | "declined" | "cancelled";

export interface SettlementEvent {
  event_id: string;
  ts: string;
  kind: SettlementEventKind;
  amount_minor?: bigint;
  currency?: string;
  raw?: unknown;
}

export interface RailCapabilities {
  rails_supported: RailName[];
  availability_signal_source: string;
}

export interface RailAdapter {
  readonly name: RailName;
  readonly enforcement_level: EnforcementLevel;
  readonly loss_ceiling_source: LossCeilingSource;
  readonly caveats: string[];
  readonly env: RailEnvironment;

  capabilities(): RailCapabilities;

  mint(args: {
    intent: Intent;
    constraints: CredentialConstraints;
    authorization_hash: string;
  }): Promise<IssuedCredential>;

  observe(credential_id: string): AsyncIterable<SettlementEvent>;

  revoke(credential_id: string): Promise<void>;

  ackSettlement(credential_id: string, event_id: string): Promise<void>;
}
