export interface AuditEntryBase {
  ts: string;
  engine_version: string;
  policy_hash: string;
  intent_id: string;
  matched_rule: string;
  counterfactuals: string[];
  normalized_facts: unknown;
  authorization_hash: string;
  decision: "allow" | "deny" | "pending_approval" | "approved" | "expired";
  rail?: string;
  credential_id?: string;
  limits_after?: Record<string, number | string>;
  settlement_events?: unknown[];
  untrusted_agent_text?: { agent_rationale?: string };
  amends?: string;
}

export interface AuditEntry extends AuditEntryBase {
  prev_hash: string;
  entry_hash: string;
}

export interface AuditSink {
  append(entry: AuditEntryBase): Promise<AuditEntry>;
  amend(prevEntryHash: string, patch: Partial<AuditEntryBase>): Promise<AuditEntry>;
}

export interface AuditAnchor {
  publish(checkpoint: { ts: string; head_hash: string }): Promise<void>;
}

export class NoopAuditAnchor implements AuditAnchor {
  async publish(_checkpoint: { ts: string; head_hash: string }): Promise<void> {}
}
