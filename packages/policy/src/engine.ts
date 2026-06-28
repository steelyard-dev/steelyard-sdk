import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { ApprovalBudget, type ApprovalBudgetOptions } from "./approval/budget.js";
import type { ApprovalChannel, ApprovalPrompt, ApprovalStatus } from "./approval/channel.js";
import { authorizationHash, type AuthorizationInputs, type CredentialConstraints } from "./auth-hash.js";
import { FileAuditSink } from "./audit/file-sink.js";
import type { AuditEntryBase } from "./audit/sink.js";
import { evaluate, type Decision } from "./evaluator.js";
import { normalizeFacts, type NormalizedFacts } from "./facts.js";
import type { FxQuoteService } from "./fx.js";
import { IpcServer } from "./ipc/server.js";
import { CallerTokenManager } from "./ipc/auth.js";
import { Counters } from "./ledger/counters.js";
import { openLedger } from "./ledger/db.js";
import { ReservationLedger, type Clock, type Reservation } from "./ledger/reservations.js";
import { fromMajor } from "./money.js";
import type { IssuedCredential, PolicyRailAdapter, RailEnvironment, SettlementEvent } from "./rail/adapter.js";
import { RailRegistry } from "./rail/registry.js";
import type { ResolvedRule } from "./schema/load.js";
import { loadPolicyFromFile, loadPolicyFromString } from "./schema/load.js";
import { PolicySnapshotStore, type PolicySnapshot } from "./snapshot.js";
import type { Intent, RailName } from "./types.js";

const ENGINE_VERSION = "0.0.0";
const DEFAULT_RESERVATION_TTL_SECONDS = 300;
const DEFAULT_APPROVAL_BUDGET: ApprovalBudgetOptions = { max: 10, window_ms: 24 * 3600 * 1000 };

export interface PolicyEngineOptions {
  dataDir: string;
  clock: Clock;
  fx: FxQuoteService;
  rails: PolicyRailAdapter[];
  policyYaml?: string;
  policyPath?: string;
  approvalChannel?: ApprovalChannel;
  approvalBudget?: ApprovalBudgetOptions;
  reservationTtlSeconds?: number;
  credentialTtlMs?: number;
  env?: RailEnvironment;
  socketPath?: string;
}

export type DecisionEnvelope =
  | {
      decision: "allow";
      intent_id: string;
      matched_rule: string;
      policy_hash: string;
      authorization_hash: string;
      credential: IssuedCredential;
    }
  | {
      decision: "deny";
      intent_id: string;
      matched_rule: string;
      policy_hash: string;
      reason_code: string;
    }
  | {
      decision: "pending_approval";
      intent_id: string;
      matched_rule: string;
      policy_hash: string;
      authorization_hash: string;
      approval_prompt_id: string;
      expires_at: string;
    };

export type PolicyDecision = DecisionEnvelope;

export interface ProposeIntentRequest {
  caller_token: string;
  idempotency_key: string;
  intent: Intent;
}

export type PaymentIntentProposal = ProposeIntentRequest;

export interface ApprovalStatusEnvelope {
  intent_id: string;
  status: ApprovalStatus;
  approval_prompt_id?: string;
  credential?: IssuedCredential;
  reason_code?: string;
}

export type ApprovalStatusResult = ApprovalStatusEnvelope;

export interface ApprovalCallbackRequest {
  approval_prompt_id: string;
  nonce: string;
  decision: "approve" | "deny";
  policy_hash?: string;
}

export type PolicyEngineApprovalCallbackResult =
  | { ok: true; status_code: 200; status: "approved" | "denied"; credential?: IssuedCredential }
  | {
      ok: false;
      status_code: 400 | 404 | 409 | 410;
      reason:
        | "invalid_body"
        | "unknown_prompt"
        | "nonce_mismatch"
        | "replayed_nonce"
        | "expired"
        | "policy_snapshot_stale"
        | "cancelled";
    };

export type ApprovalCallbackResult = PolicyEngineApprovalCallbackResult;

export interface PolicySnapshotMetadata {
  policy_hash: string;
  version: string;
  loaded_at: string;
  rule_names: string[];
  current: boolean;
}

interface SnapshotMetaInternal extends PolicySnapshotMetadata {
  policy_hash: string;
}

interface CredentialRecord {
  caller_token: string;
  public_credential_id: string;
  rail_credential_id: string;
  rail: RailName;
  adapter: PolicyRailAdapter;
  snapshot_hash: string;
  released_snapshot: boolean;
  audit_entry_hash?: string;
}

interface IntentRecordBase {
  caller_token: string;
  intent: Intent;
  intent_id: string;
  matched_rule: string;
  policy_hash: string;
  counterfactuals: string[];
  facts: NormalizedFacts;
  authorization_hash: string;
  auth_inputs: AuthorizationInputs;
  constraints: CredentialConstraints;
  rail: RailName;
  reservation_id?: string;
  snapshot_retained: boolean;
  audit_entry_hash?: string;
  limits_after?: Record<string, string | number>;
}

interface PendingApprovalRecord extends IntentRecordBase {
  state: "pending_approval" | "approved" | "denied" | "expired" | "cancelled" | "stale";
  approval_prompt_id: string;
  nonce: string;
  approval_prompt_hash: string;
  expires_at: string;
  credential?: IssuedCredential;
  reason_code?: string;
}

interface CredentialIntentRecord extends IntentRecordBase {
  state: "allow";
  credential: IssuedCredential;
}

type IntentRecord = PendingApprovalRecord | CredentialIntentRecord | { state: "deny"; caller_token: string; intent_id: string };

export class PolicyEngine {
  private db?: Database.Database;
  private ledger?: ReservationLedger;
  private counters?: Counters;
  private audit?: FileAuditSink;
  private readonly snapshots = new PolicySnapshotStore();
  private readonly snapshotMeta = new Map<string, SnapshotMetaInternal>();
  private readonly rails = new RailRegistry();
  private readonly approvalBudget: ApprovalBudget;
  private readonly idempotency = new Map<string, DecisionEnvelope>();
  private readonly intents = new Map<string, IntentRecord>();
  private readonly prompts = new Map<string, PendingApprovalRecord>();
  private readonly credentials = new Map<string, CredentialRecord>();
  private tokensPath = "";
  private lockPath = "";
  private lockHeld = false;
  private ipc?: IpcServer;

  constructor(private readonly opts: PolicyEngineOptions) {
    this.approvalBudget = new ApprovalBudget(opts.approvalBudget ?? DEFAULT_APPROVAL_BUDGET, opts.clock);
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.dataDir, { recursive: true, mode: 0o700 });
    this.acquireLock();
    this.tokensPath = join(this.opts.dataDir, "caller.token");
    this.db = openLedger(join(this.opts.dataDir, "policy.sqlite"));
    this.ledger = new ReservationLedger(this.db, this.opts.clock, {
      ttl_seconds: this.opts.reservationTtlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS
    });
    this.ledger.recoverExpired();
    this.counters = new Counters(this.db, this.opts.clock);
    this.audit = new FileAuditSink(join(this.opts.dataDir, "audit"), this.opts.clock);
    for (const adapter of this.opts.rails) this.rails.register(adapter);
    this.loadInitialPolicy();
    if (this.opts.socketPath) {
      this.ipc = await new IpcServer({
        socketPath: this.opts.socketPath,
        tokenPath: this.tokensPath,
        handlers: this.ipcHandlers()
      }).start();
    } else {
      new CallerTokenManager(this.tokensPath).ensure();
    }
  }

  async stop(): Promise<void> {
    if (this.ipc) {
      await this.ipc.stop();
      this.ipc = undefined;
    }
    this.db?.close();
    this.db = undefined;
    this.releaseLock();
  }

  callerToken(): string {
    return readFileSync(this.tokensPath, "utf8").trim();
  }

  ipcHandlers() {
    return {
      proposeIntent: (params: Record<string, unknown>) => this.proposeIntent(params as unknown as ProposeIntentRequest),
      getApprovalStatus: (params: Record<string, unknown>) =>
        this.getApprovalStatus(params as unknown as { caller_token: string; intent_id: string }),
      cancelIntent: (params: Record<string, unknown>) => this.cancelIntent(params as unknown as { caller_token: string; intent_id: string }),
      revokeCredential: (params: Record<string, unknown>) =>
        this.revokeCredential(params as unknown as { caller_token: string; credential_id: string }),
      ackSettlement: (params: Record<string, unknown>) =>
        this.ackSettlement(params as unknown as { caller_token: string; credential_id: string; event_id: string }),
      getPolicySnapshot: (params: Record<string, unknown>) =>
        this.getPolicySnapshot(params as unknown as { caller_token: string; policy_hash?: string }),
      capabilities: (params: Record<string, unknown>) => this.capabilities(params as unknown as { caller_token: string })
    };
  }

  async reloadPolicy(policyYaml?: string): Promise<PolicySnapshotMetadata> {
    const loaded = policyYaml === undefined ? loadPolicyFromFile(this.policyPath()) : loadPolicyFromString(policyYaml);
    const snapshot = this.snapshots.add(loaded.policy, policyYaml ?? readFileSync(this.policyPath(), "utf8"));
    const metadata = this.recordSnapshot(snapshot);
    this.persistSnapshot(snapshot);
    this.snapshots.gc();
    return metadata;
  }

  async proposeIntent(req: ProposeIntentRequest): Promise<DecisionEnvelope> {
    this.authenticate(req.caller_token);
    if (!req.idempotency_key) throw new Error("idempotency_key is required");
    const idemKey = `${req.caller_token}:${req.idempotency_key}`;
    const cached = this.idempotency.get(idemKey);
    if (cached) return cached;

    const snapshot = this.snapshots.getCurrent();
    const facts = await normalizeFacts({ intent: req.intent, fx: this.opts.fx });
    const decision = evaluate(snapshot.policy, facts);
    const intent_id = `int_${randomUUID()}`;

    if (decision.effect === "deny") {
      const env = this.denyEnvelope({
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        reason_code: decision.matched_rule === "<no-match>" ? "no_matching_rule" : `matched:${decision.matched_rule}`
      });
      await this.writeAudit({
        policy_hash: snapshot.policy_hash,
        intent_id,
        decision,
        facts,
        authorization_hash: "",
        audit_decision: "deny"
      });
      this.intents.set(intent_id, { state: "deny", caller_token: req.caller_token, intent_id });
      this.idempotency.set(idemKey, env);
      return env;
    }

    const rail = decision.rule.rail ?? "virtual_card";
    const railAdapter = this.rails.get(rail);
    if (railAdapter.env !== (this.opts.env ?? railAdapter.env)) {
      const env = this.denyEnvelope({
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        reason_code: "rail_env_mismatch"
      });
      this.idempotency.set(idemKey, env);
      return env;
    }

    if (decision.effect === "require_approval") {
      const env = await this.createApproval({ req, idemKey, snapshot, facts, decision, rail });
      return env;
    }

    const prepared = this.prepareAuthorization({
      snapshot,
      facts,
      decision,
      intent: req.intent,
      rail,
      approval_prompt_hash: ""
    });
    const reservation = this.reserveAfterLimitCheck(decision.rule, intent_id, facts.amount_usd.value.amount_minor, req.intent.purchase_id);
    if ("denied" in reservation) {
      const env = this.denyEnvelope({
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        reason_code: reservation.reason_code
      });
      await this.writeAudit({
        policy_hash: snapshot.policy_hash,
        intent_id,
        decision,
        facts,
        authorization_hash: prepared.authorization_hash,
        audit_decision: "deny",
        limits_after: reservation.limits_after
      });
      this.idempotency.set(idemKey, env);
      return env;
    }

    this.snapshots.retain(snapshot.policy_hash);
    try {
      const credential = await this.mintCredential({
        caller_token: req.caller_token,
        intent_id,
        railAdapter,
        intent: req.intent,
        constraints: prepared.constraints,
        authorization_hash: prepared.authorization_hash,
        snapshot_hash: snapshot.policy_hash
      });
      this.ledgerRequired().commit(reservation.reservation.id, credential.credential_id);
      const audit = await this.writeAudit({
        policy_hash: snapshot.policy_hash,
        intent_id,
        decision,
        facts,
        authorization_hash: prepared.authorization_hash,
        audit_decision: "allow",
        rail,
        credential_id: credential.credential_id,
        limits_after: reservation.limits_after
      });
      this.attachCredentialAuditHash(credential.credential_id, audit.entry_hash);
      const record: CredentialIntentRecord = {
        state: "allow",
        caller_token: req.caller_token,
        intent: req.intent,
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        counterfactuals: decision.counterfactuals,
        facts,
        authorization_hash: prepared.authorization_hash,
        auth_inputs: prepared.auth_inputs,
        constraints: prepared.constraints,
        rail,
        reservation_id: reservation.reservation.id,
        snapshot_retained: true,
        credential,
        audit_entry_hash: audit.entry_hash,
        limits_after: reservation.limits_after
      };
      this.intents.set(intent_id, record);
      const env: DecisionEnvelope = {
        decision: "allow",
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        authorization_hash: prepared.authorization_hash,
        credential
      };
      this.idempotency.set(idemKey, env);
      return env;
    } catch (error) {
      this.ledgerRequired().release(reservation.reservation.id);
      this.snapshots.release(snapshot.policy_hash);
      this.snapshots.gc();
      throw error;
    }
  }

  async getApprovalStatus(req: { caller_token: string; intent_id: string }): Promise<ApprovalStatusEnvelope> {
    this.authenticate(req.caller_token);
    const record = this.intents.get(req.intent_id);
    if (!record || record.caller_token !== req.caller_token) throw new Error("intent not found");
    if (record.state === "deny") return { intent_id: req.intent_id, status: "denied" };
    if (record.state === "allow") return { intent_id: req.intent_id, status: "approved", credential: record.credential };
    if (record.state === "pending_approval" && this.isExpired(record)) {
      await this.expirePrompt(record);
    }
    return {
      intent_id: req.intent_id,
      status: approvalStatusFromRecord(record),
      approval_prompt_id: record.approval_prompt_id,
      credential: record.credential,
      reason_code: record.reason_code
    };
  }

  async cancelIntent(req: { caller_token: string; intent_id: string }): Promise<{ ok: true }> {
    this.authenticate(req.caller_token);
    const record = this.intents.get(req.intent_id);
    if (!record || record.caller_token !== req.caller_token) throw new Error("intent not found");
    if (isPendingApprovalRecord(record) && record.state === "pending_approval") {
      record.state = "cancelled";
      record.reason_code = "cancelled";
      this.releaseReservation(record);
      this.releaseSnapshot(record);
      await this.writeAuditFromRecord(record, "deny", "cancelled");
      this.updateApprovalStatus(record, "denied");
    }
    return { ok: true };
  }

  async handleApprovalCallback(req: ApprovalCallbackRequest): Promise<PolicyEngineApprovalCallbackResult> {
    if (!req.approval_prompt_id || !req.nonce || (req.decision !== "approve" && req.decision !== "deny")) {
      return { ok: false, status_code: 400, reason: "invalid_body" };
    }
    const record = this.prompts.get(req.approval_prompt_id);
    if (!record) return { ok: false, status_code: 404, reason: "unknown_prompt" };
    if (record.nonce !== req.nonce) return { ok: false, status_code: 400, reason: "nonce_mismatch" };
    if (record.state === "approved" || record.state === "denied") {
      return { ok: false, status_code: 409, reason: "replayed_nonce" };
    }
    if (record.state === "cancelled") return { ok: false, status_code: 410, reason: "cancelled" };
    if (this.isExpired(record)) {
      await this.expirePrompt(record);
      return { ok: false, status_code: 410, reason: "expired" };
    }
    if (record.policy_hash !== this.snapshots.getCurrent().policy_hash || (req.policy_hash && req.policy_hash !== this.snapshots.getCurrent().policy_hash)) {
      record.state = "stale";
      record.reason_code = "policy_snapshot_stale";
      this.releaseReservation(record);
      this.releaseSnapshot(record);
      this.updateApprovalStatus(record, "denied");
      await this.writeAuditFromRecord(record, "deny", "policy_snapshot_stale");
      return { ok: false, status_code: 409, reason: "policy_snapshot_stale" };
    }

    if (req.decision === "deny") {
      record.state = "denied";
      record.reason_code = "user_denied";
      this.releaseReservation(record);
      this.releaseSnapshot(record);
      this.updateApprovalStatus(record, "denied");
      await this.writeAuditFromRecord(record, "deny", "user_denied");
      return { ok: true, status_code: 200, status: "denied" };
    }

    const recomputed = authorizationHash(record.auth_inputs);
    if (recomputed !== record.authorization_hash) {
      throw new Error("authorization_hash inputs mutated before mint");
    }

    const railAdapter = this.rails.get(record.rail);
    const credential = await this.mintCredential({
      caller_token: record.caller_token,
      intent_id: record.intent_id,
      railAdapter,
      intent: record.intent,
      constraints: record.constraints,
      authorization_hash: record.authorization_hash,
      snapshot_hash: record.policy_hash
    });
    this.ledgerRequired().commit(record.reservation_id!, credential.credential_id);
    record.state = "approved";
    record.credential = credential;
    this.updateApprovalStatus(record, "approved");
    const audit = await this.writeAuditFromRecord(record, "approved", undefined, credential.credential_id);
    this.attachCredentialAuditHash(credential.credential_id, audit.entry_hash);
    return { ok: true, status_code: 200, status: "approved", credential };
  }

  async revokeCredential(req: { caller_token: string; credential_id: string }): Promise<{ ok: true }> {
    this.authenticate(req.caller_token);
    const record = this.credentials.get(req.credential_id);
    if (!record || record.caller_token !== req.caller_token) throw new Error("credential not found");
    await record.adapter.revoke(record.rail_credential_id);
    this.releaseCredentialSnapshot(record);
    return { ok: true };
  }

  async ackSettlement(req: { caller_token: string; credential_id: string; event_id: string }): Promise<{ ok: true }> {
    this.authenticate(req.caller_token);
    const record = this.credentials.get(req.credential_id);
    if (!record || record.caller_token !== req.caller_token) throw new Error("credential not found");
    await record.adapter.ackSettlement(record.rail_credential_id, req.event_id);
    const settlement_events = await settlementEventsFor(record.adapter, record.rail_credential_id, req.event_id);
    if (record.audit_entry_hash && settlement_events.length > 0) {
      await this.auditRequired().amend(record.audit_entry_hash, {
        ts: this.opts.clock.now().toISOString(),
        settlement_events
      });
    }
    this.releaseCredentialSnapshot(record);
    return { ok: true };
  }

  async getPolicySnapshot(req: { caller_token: string; policy_hash?: string }): Promise<PolicySnapshotMetadata> {
    this.authenticate(req.caller_token);
    const hash = req.policy_hash ?? this.snapshots.getCurrent().policy_hash;
    const meta = this.snapshotMeta.get(hash);
    if (!meta) throw new Error("policy snapshot not found");
    return { ...meta, current: hash === this.snapshots.getCurrent().policy_hash };
  }

  async capabilities(req: { caller_token: string }): Promise<{ rails_enabled: RailName[]; engine_version: string; policy_hash: string }> {
    this.authenticate(req.caller_token);
    return {
      rails_enabled: this.opts.rails.map((rail) => rail.name),
      engine_version: ENGINE_VERSION,
      policy_hash: this.snapshots.getCurrent().policy_hash
    };
  }

  observeCredential(credential_id: string): AsyncIterable<SettlementEvent> {
    const record = this.credentials.get(credential_id);
    if (!record) throw new Error("credential not found");
    return record.adapter.observe(record.rail_credential_id);
  }

  private async createApproval(args: {
    req: ProposeIntentRequest;
    idemKey: string;
    snapshot: PolicySnapshot;
    facts: NormalizedFacts;
    decision: Decision;
    rail: RailName;
  }): Promise<DecisionEnvelope> {
    const { req, idemKey, snapshot, facts, decision, rail } = args;
    const intent_id = `int_${randomUUID()}`;
    if (!this.opts.approvalChannel) {
      const env = this.denyEnvelope({
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        reason_code: "approval_channel_missing"
      });
      this.idempotency.set(idemKey, env);
      return env;
    }
    if (!this.approvalBudget.tryConsume()) {
      const env = this.denyEnvelope({
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        reason_code: "approval_budget_exhausted"
      });
      await this.writeAudit({
        policy_hash: snapshot.policy_hash,
        intent_id,
        decision,
        facts,
        authorization_hash: "",
        audit_decision: "deny"
      });
      this.idempotency.set(idemKey, env);
      return env;
    }

    const expires_at = new Date(this.opts.clock.now().getTime() + parseDurationMs(decision.rule.approval?.expires_in ?? "5m")).toISOString();
    const approval_prompt_id = `ap_${randomUUID()}`;
    const nonce = randomUUID();
    const approval_prompt_hash = promptHash({
      approval_prompt_id,
      nonce,
      policy_hash: snapshot.policy_hash,
      merchant_domain: facts.merchant_domain.value,
      amount_usd_minor: facts.amount_usd.value.amount_minor,
      expires_at
    });
    const prepared = this.prepareAuthorization({
      snapshot,
      facts,
      decision,
      intent: req.intent,
      rail,
      approval_prompt_hash
    });
    const reservation = this.reserveAfterLimitCheck(decision.rule, intent_id, facts.amount_usd.value.amount_minor, req.intent.purchase_id);
    if ("denied" in reservation) {
      const env = this.denyEnvelope({
        intent_id,
        matched_rule: decision.matched_rule,
        policy_hash: snapshot.policy_hash,
        reason_code: reservation.reason_code
      });
      this.idempotency.set(idemKey, env);
      return env;
    }

    this.snapshots.retain(snapshot.policy_hash);
    const prompt: ApprovalPrompt = {
      approval_prompt_id,
      nonce,
      policy_hash: snapshot.policy_hash,
      authorization_hash: prepared.authorization_hash,
      prompt_text: `${facts.merchant_domain.value} requests ${facts.amount_usd.value.currency} ${facts.amount_usd.value.amount_minor.toString()} minor units`,
      agent_rationale_quarantined: req.intent.agent_rationale,
      expires_at
    };

    try {
      const returned = await this.opts.approvalChannel.prompt(prompt);
      if (returned.approval_prompt_id !== approval_prompt_id || returned.nonce !== nonce) {
        throw new Error("approval channel returned mismatched prompt identity");
      }
    } catch (error) {
      this.ledgerRequired().release(reservation.reservation.id);
      this.snapshots.release(snapshot.policy_hash);
      this.snapshots.gc();
      throw error;
    }

    const record: PendingApprovalRecord = {
      state: "pending_approval",
      caller_token: req.caller_token,
      intent: req.intent,
      intent_id,
      matched_rule: decision.matched_rule,
      policy_hash: snapshot.policy_hash,
      counterfactuals: decision.counterfactuals,
      facts,
      authorization_hash: prepared.authorization_hash,
      auth_inputs: prepared.auth_inputs,
      constraints: prepared.constraints,
      rail,
      reservation_id: reservation.reservation.id,
      snapshot_retained: true,
      approval_prompt_id,
      nonce,
      approval_prompt_hash,
      expires_at,
      limits_after: reservation.limits_after
    };
    this.prompts.set(approval_prompt_id, record);
    this.intents.set(intent_id, record);
    this.persistApproval(record);
    const audit = await this.writeAudit({
      policy_hash: snapshot.policy_hash,
      intent_id,
      decision,
      facts,
      authorization_hash: prepared.authorization_hash,
      audit_decision: "pending_approval",
      rail,
      limits_after: reservation.limits_after
    });
    record.audit_entry_hash = audit.entry_hash;

    const env: DecisionEnvelope = {
      decision: "pending_approval",
      intent_id,
      matched_rule: decision.matched_rule,
      policy_hash: snapshot.policy_hash,
      authorization_hash: prepared.authorization_hash,
      approval_prompt_id,
      expires_at
    };
    this.idempotency.set(idemKey, env);
    return env;
  }

  private prepareAuthorization(args: {
    snapshot: PolicySnapshot;
    facts: NormalizedFacts;
    decision: Decision;
    intent: Intent;
    rail: RailName;
    approval_prompt_hash: string;
  }): { authorization_hash: string; constraints: CredentialConstraints; auth_inputs: AuthorizationInputs } {
    const constraints: CredentialConstraints = {
      amount_minor: args.intent.amount.amount_minor,
      currency: args.intent.amount.currency.toUpperCase(),
      expires_at: new Date(this.opts.clock.now().getTime() + (this.opts.credentialTtlMs ?? 24 * 3600 * 1000)).toISOString()
    };
    const auth_inputs: AuthorizationInputs = {
      policy_hash: args.snapshot.policy_hash,
      rule_name: args.decision.matched_rule,
      rail: args.rail,
      credential_constraints: constraints,
      approval_prompt_hash: args.approval_prompt_hash,
      fx_quote: args.facts.fx_quote ?? { id: "fxq_identity_usd", ts: this.opts.clock.now().toISOString() },
      rail_native: { amount_minor: args.intent.amount.amount_minor, currency: args.intent.amount.currency.toUpperCase() },
      normalized_facts: args.facts
    };
    return { authorization_hash: authorizationHash(auth_inputs), constraints, auth_inputs };
  }

  private reserveAfterLimitCheck(
    rule: ResolvedRule,
    intent_id: string,
    amount_usd_minor: bigint,
    purchase_id: string | undefined
  ):
    | { reservation: Reservation; limits_after: Record<string, string | number> }
    | { denied: true; reason_code: string; limits_after: Record<string, string | number> } {
    const db = this.dbRequired();
    db.exec("BEGIN IMMEDIATE");
    try {
      const limits = rule.limits ?? {};
      const perDayUsd = this.countersRequired().perDayUsdMinor(rule.name);
      const perDayCount = this.countersRequired().perDayCount(rule.name);
      const perPurchaseUsd = purchase_id ? this.countersRequired().perPurchaseUsdMinor(purchase_id) : 0n;
      const limits_after = {
        per_day_usd_minor: (perDayUsd + amount_usd_minor).toString(),
        per_day_count: perDayCount + 1,
        ...(purchase_id ? { per_purchase_usd_minor: (perPurchaseUsd + amount_usd_minor).toString() } : {})
      };

      if (limits.per_day_usd !== undefined && perDayUsd + amount_usd_minor > limitUsdMinor(limits.per_day_usd)) {
        db.exec("ROLLBACK");
        return { denied: true, reason_code: "limit:per_day_usd", limits_after };
      }
      if (limits.per_day_count !== undefined && perDayCount + 1 > limits.per_day_count) {
        db.exec("ROLLBACK");
        return { denied: true, reason_code: "limit:per_day_count", limits_after };
      }
      if (purchase_id && limits.per_purchase_usd !== undefined && perPurchaseUsd + amount_usd_minor > limitUsdMinor(limits.per_purchase_usd)) {
        db.exec("ROLLBACK");
        return { denied: true, reason_code: "limit:per_purchase_usd", limits_after };
      }

      const reservation = insertReservation({
        db,
        clock: this.opts.clock,
        ttl_seconds: this.opts.reservationTtlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS,
        rule_name: rule.name,
        intent_id,
        amount_usd_minor,
        purchase_id
      });
      db.exec("COMMIT");
      return { reservation, limits_after };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private async mintCredential(args: {
    caller_token: string;
    intent_id: string;
    railAdapter: PolicyRailAdapter;
    intent: Intent;
    constraints: CredentialConstraints;
    authorization_hash: string;
    snapshot_hash: string;
  }): Promise<IssuedCredential> {
    const railCredential = await args.railAdapter.mint({
      intent: args.intent,
      constraints: args.constraints,
      authorization_hash: args.authorization_hash
    });
    if (railCredential.authorization_hash !== args.authorization_hash) {
      throw new Error("rail returned credential for different authorization_hash");
    }
    const publicCredentialId = `cred_${randomUUID()}`;
    const credential = { ...railCredential, credential_id: publicCredentialId };
    this.credentials.set(publicCredentialId, {
      caller_token: args.caller_token,
      public_credential_id: publicCredentialId,
      rail_credential_id: railCredential.credential_id,
      rail: railCredential.rail,
      adapter: args.railAdapter,
      snapshot_hash: args.snapshot_hash,
      released_snapshot: false
    });
    this.dbRequired()
      .prepare(
        `INSERT INTO credentials (credential_id, intent_id, rail, authorization_hash, policy_hash, created_at, env)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        publicCredentialId,
        args.intent_id,
        railCredential.rail,
        args.authorization_hash,
        args.snapshot_hash,
        this.opts.clock.now().toISOString(),
        args.railAdapter.env
      );
    return credential;
  }

  private async writeAudit(args: {
    policy_hash: string;
    intent_id: string;
    decision: Pick<Decision, "matched_rule" | "counterfactuals">;
    facts: NormalizedFacts;
    authorization_hash: string;
    audit_decision: AuditEntryBase["decision"];
    rail?: RailName;
    credential_id?: string;
    limits_after?: Record<string, string | number>;
    reason_code?: string;
  }) {
    const entry = await this.auditRequired().append({
      ts: this.opts.clock.now().toISOString(),
      engine_version: ENGINE_VERSION,
      policy_hash: args.policy_hash,
      intent_id: args.intent_id,
      matched_rule: args.decision.matched_rule,
      counterfactuals: args.decision.counterfactuals,
      normalized_facts: args.facts,
      authorization_hash: args.authorization_hash,
      decision: args.audit_decision,
      rail: args.rail,
      credential_id: args.credential_id,
      limits_after: args.limits_after,
      untrusted_agent_text: args.facts.untrusted_agent_text
    });
    this.dbRequired()
      .prepare(
        `INSERT INTO audit (entry_hash, ts, intent_id, authorization_hash, policy_hash, decision, entry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.entry_hash,
        entry.ts,
        entry.intent_id,
        entry.authorization_hash,
        entry.policy_hash,
        entry.decision,
        JSON.stringify(entry, jsonReplacer)
      );
    return entry;
  }

  private async writeAuditFromRecord(
    record: PendingApprovalRecord,
    decision: AuditEntryBase["decision"],
    reason_code?: string,
    credential_id?: string
  ) {
    return await this.writeAudit({
      policy_hash: record.policy_hash,
      intent_id: record.intent_id,
      decision: { matched_rule: record.matched_rule, counterfactuals: record.counterfactuals },
      facts: record.facts,
      authorization_hash: record.authorization_hash,
      audit_decision: decision,
      rail: record.rail,
      credential_id,
      limits_after: { ...(record.limits_after ?? {}), ...(reason_code ? { reason_code } : {}) }
    });
  }

  private attachCredentialAuditHash(credential_id: string, audit_entry_hash: string): void {
    const credential = this.credentials.get(credential_id);
    if (credential) credential.audit_entry_hash = audit_entry_hash;
  }

  private async expirePrompt(record: PendingApprovalRecord): Promise<void> {
    if (record.state !== "pending_approval") return;
    record.state = "expired";
    record.reason_code = "expired";
    this.releaseReservation(record);
    this.releaseSnapshot(record);
    this.updateApprovalStatus(record, "expired");
    await this.writeAuditFromRecord(record, "expired", "expired");
  }

  private releaseReservation(record: PendingApprovalRecord): void {
    if (!record.reservation_id) return;
    try {
      this.ledgerRequired().release(record.reservation_id);
    } catch {
      // Already committed/released records are terminal for the approval flow.
    }
    record.reservation_id = undefined;
  }

  private releaseSnapshot(record: IntentRecordBase): void {
    if (!record.snapshot_retained) return;
    this.snapshots.release(record.policy_hash);
    record.snapshot_retained = false;
    this.snapshots.gc();
  }

  private releaseCredentialSnapshot(record: CredentialRecord): void {
    if (record.released_snapshot) return;
    this.snapshots.release(record.snapshot_hash);
    record.released_snapshot = true;
    this.snapshots.gc();
  }

  private updateApprovalStatus(record: PendingApprovalRecord, status: ApprovalStatus): void {
    this.dbRequired()
      .prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE approval_prompt_id = ?")
      .run(status, this.opts.clock.now().toISOString(), record.approval_prompt_id);
  }

  private persistApproval(record: PendingApprovalRecord): void {
    this.dbRequired()
      .prepare(
        `INSERT INTO approvals
          (approval_prompt_id, intent_id, nonce, policy_hash, authorization_hash, prompt_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        record.approval_prompt_id,
        record.intent_id,
        record.nonce,
        record.policy_hash,
        record.authorization_hash,
        record.approval_prompt_hash,
        this.opts.clock.now().toISOString(),
        record.expires_at
      );
  }

  private recordSnapshot(snapshot: PolicySnapshot): PolicySnapshotMetadata {
    const metadata: SnapshotMetaInternal = {
      policy_hash: snapshot.policy_hash,
      version: snapshot.policy.version,
      loaded_at: this.opts.clock.now().toISOString(),
      rule_names: snapshot.policy.rules.map((rule) => rule.name),
      current: true
    };
    this.snapshotMeta.set(snapshot.policy_hash, metadata);
    return { ...metadata };
  }

  private persistSnapshot(snapshot: PolicySnapshot): void {
    this.dbRequired()
      .prepare("INSERT OR IGNORE INTO policy_snapshots (policy_hash, yaml_bytes, created_at) VALUES (?, ?, ?)")
      .run(snapshot.policy_hash, snapshot.yaml_bytes, this.opts.clock.now().toISOString());
  }

  private loadInitialPolicy(): void {
    const loaded = this.opts.policyYaml === undefined ? loadPolicyFromFile(this.policyPath()) : loadPolicyFromString(this.opts.policyYaml);
    const snapshot = this.snapshots.add(loaded.policy, this.opts.policyYaml ?? readFileSync(this.policyPath(), "utf8"));
    this.recordSnapshot(snapshot);
    this.persistSnapshot(snapshot);
  }

  private policyPath(): string {
    if (this.opts.policyPath) return this.opts.policyPath;
    throw new Error("policyPath is required when policyYaml is not provided");
  }

  private authenticate(caller_token: string): void {
    if (caller_token !== this.callerToken()) throw new Error("unauthenticated");
  }

  private denyEnvelope(args: { intent_id: string; matched_rule: string; policy_hash: string; reason_code: string }): DecisionEnvelope {
    return {
      decision: "deny",
      intent_id: args.intent_id,
      matched_rule: args.matched_rule,
      policy_hash: args.policy_hash,
      reason_code: args.reason_code
    };
  }

  private isExpired(record: PendingApprovalRecord): boolean {
    return Date.parse(record.expires_at) <= this.opts.clock.now().getTime();
  }

  private dbRequired(): Database.Database {
    if (!this.db) throw new Error("engine not started");
    return this.db;
  }

  private ledgerRequired(): ReservationLedger {
    if (!this.ledger) throw new Error("engine not started");
    return this.ledger;
  }

  private countersRequired(): Counters {
    if (!this.counters) throw new Error("engine not started");
    return this.counters;
  }

  private auditRequired(): FileAuditSink {
    if (!this.audit) throw new Error("engine not started");
    return this.audit;
  }

  private acquireLock(): void {
    this.lockPath = join(this.opts.dataDir, "policy.lock");
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && isLivePid(pid)) {
        throw new Error(`policy engine data dir is locked by live pid ${pid}`);
      }
      unlinkSync(this.lockPath);
    }
    writeFileSync(this.lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    this.lockHeld = true;
  }

  private releaseLock(): void {
    if (!this.lockHeld || !this.lockPath) return;
    if (existsSync(this.lockPath) && readFileSync(this.lockPath, "utf8").trim() === String(process.pid)) {
      unlinkSync(this.lockPath);
    }
    this.lockHeld = false;
  }
}

export function createPolicyEngine(opts: PolicyEngineOptions): PolicyEngine {
  return new PolicyEngine(opts);
}

function insertReservation(args: {
  db: Database.Database;
  clock: Clock;
  ttl_seconds: number;
  rule_name: string;
  intent_id: string;
  amount_usd_minor: bigint;
  purchase_id?: string;
}): Reservation {
  const id = `res_${randomUUID()}`;
  const now = args.clock.now();
  const expires = new Date(now.getTime() + args.ttl_seconds * 1000);
  const reservation: Reservation = {
    id,
    rule_name: args.rule_name,
    intent_id: args.intent_id,
    amount_usd_minor: args.amount_usd_minor,
    count: 1,
    purchase_id: args.purchase_id ?? null,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: "pending",
    credential_id: null
  };
  args.db
    .prepare(
      `INSERT INTO reservations
        (id, rule_name, intent_id, amount_usd_minor, count, purchase_id, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(
      reservation.id,
      reservation.rule_name,
      reservation.intent_id,
      safeSqliteInteger(reservation.amount_usd_minor),
      reservation.count,
      reservation.purchase_id,
      reservation.created_at,
      reservation.expires_at
    );
  return reservation;
}

function limitUsdMinor(value: number): bigint {
  return fromMajor(String(value), "USD");
}

function safeSqliteInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`amount_usd_minor exceeds SQLite safe integer range: ${value}`);
  }
  return Number(value);
}

function parseDurationMs(value: string): number {
  const match = /^([0-9]+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  return amount * 60 * 60 * 1000;
}

function promptHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}

function approvalStatusFromRecord(record: PendingApprovalRecord): ApprovalStatus {
  if (record.state === "approved") return "approved";
  if (record.state === "expired") return "expired";
  if (record.state === "pending_approval") return "pending";
  return "denied";
}

function isPendingApprovalRecord(record: IntentRecord): record is PendingApprovalRecord {
  return "approval_prompt_id" in record;
}

async function settlementEventsFor(adapter: PolicyRailAdapter, railCredentialId: string, eventId: string): Promise<SettlementEvent[]> {
  const events: SettlementEvent[] = [];
  for await (const event of adapter.observe(railCredentialId)) {
    if (event.event_id === eventId) events.push(event);
  }
  return events;
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EPERM") {
      return true;
    }
    return false;
  }
}
