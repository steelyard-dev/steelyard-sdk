import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalChannel, ApprovalPrompt, ApprovalStatus } from "../src/approval/channel.js";
import { PolicyEngine } from "../src/engine.js";
import { InMemoryFxQuoteService } from "../src/fx.js";
import type { PolicyRailAdapter } from "../src/rail/adapter.js";
import type { SettlementEvent } from "../src/rail/adapter.js";
import type { Intent } from "../src/types.js";

const POLICY = `
version: 2026-06-27
trusted_domains: { tier1: [amazon.com] }
rules:
  - name: trusted-small
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 100 }, type: one_time }
    limits: { per_day_usd: 300, per_day_count: 3, per_purchase_usd: 200 }
  - name: needs-approval
    do: require_approval
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 500 }, type: one_time }
    limits: { per_day_usd: 1000 }
    approval: { who: user, channel: webhook, expires_in: 5m }
  - name: deny-all
    do: deny
`;

const RELOADED_POLICY = `
version: 2026-06-27
trusted_domains: { tier1: [amazon.com] }
rules:
  - name: deny-amazon
    do: deny
    when: { merchant_domain_in: tier1 }
  - name: deny-all
    do: deny
`;

class MutableClock {
  private value = new Date("2026-06-28T12:00:00.000Z");

  now(): Date {
    return new Date(this.value);
  }

  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}

class MemoryApprovalChannel implements ApprovalChannel {
  readonly prompts: ApprovalPrompt[] = [];
  private statuses = new Map<string, ApprovalStatus>();

  async prompt(req: ApprovalPrompt): Promise<{ approval_prompt_id: string; nonce: string }> {
    this.prompts.push(req);
    this.statuses.set(req.approval_prompt_id, "pending");
    return { approval_prompt_id: req.approval_prompt_id, nonce: req.nonce };
  }

  async status(id: string): Promise<ApprovalStatus> {
    return this.statuses.get(id) ?? "expired";
  }
}

interface FakeCardRail extends PolicyRailAdapter {
  mintCount: number;
  minted: Array<{ authorization_hash: string; constraints_amount_minor: bigint }>;
  revoked: string[];
  acked: Array<{ credential_id: string; event_id: string }>;
  events: SettlementEvent[];
  failMint?: boolean;
  mismatchAuth?: boolean;
}

const engines: PolicyEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
});

function fakeCardAdapter(opts: { env?: "sandbox" | "production"; failMint?: boolean; mismatchAuth?: boolean } = {}): FakeCardRail {
  const adapter: FakeCardRail = {
    name: "virtual_card",
    enforcement_level: "network_enforced",
    loss_ceiling_source: "per_credential",
    caveats: [],
    env: opts.env ?? "sandbox",
    mintCount: 0,
    minted: [],
    revoked: [],
    acked: [],
    events: [],
    failMint: opts.failMint,
    mismatchAuth: opts.mismatchAuth,
    capabilities: () => ({ rails_supported: ["virtual_card"], availability_signal_source: "fake" }),
    mint: async ({ authorization_hash, constraints }) => {
      if (adapter.failMint) throw new Error("mint failed");
      adapter.mintCount += 1;
      adapter.minted.push({ authorization_hash, constraints_amount_minor: constraints.amount_minor });
      return {
        credential_id: `rail_${authorization_hash.slice(7, 15)}`,
        authorization_hash: adapter.mismatchAuth ? "sha256:mismatch" : authorization_hash,
        rail: "virtual_card",
        payload: { pan: "4242424242424242", cvv: "123", expiry: "12/26", zip: "00000" },
        expires_at: constraints.expires_at
      };
    },
    observe: async function* () {
      yield* adapter.events;
    },
    revoke: async (credential_id) => {
      adapter.revoked.push(credential_id);
    },
    ackSettlement: async (credential_id, event_id) => {
      adapter.acked.push({ credential_id, event_id });
    }
  };
  return adapter;
}

async function makeEngine(opts: {
  policyYaml?: string;
  policyPath?: string;
  approvalBudgetMax?: number;
  approvalChannel?: MemoryApprovalChannel;
  socketPath?: string;
  rail?: FakeCardRail;
  env?: "sandbox" | "production";
} = {}): Promise<{ engine: PolicyEngine; rail: FakeCardRail; approvals: MemoryApprovalChannel; clock: MutableClock; dataDir: string }> {
  const clock = new MutableClock();
  const dataDir = mkdtempSync(join(tmpdir(), "engine-"));
  const rail = opts.rail ?? fakeCardAdapter();
  const approvals = opts.approvalChannel ?? new MemoryApprovalChannel();
  const engine = new PolicyEngine({
    dataDir,
    clock,
    fx: new InMemoryFxQuoteService({}, () => clock.now()),
    rails: [rail],
    policyYaml: opts.policyPath ? undefined : (opts.policyYaml ?? POLICY),
    policyPath: opts.policyPath,
    approvalChannel: approvals,
    approvalBudget: { max: opts.approvalBudgetMax ?? 10, window_ms: 24 * 3600 * 1000 },
    socketPath: opts.socketPath,
    env: opts.env
  });
  await engine.start();
  engines.push(engine);
  return { engine, rail, approvals, clock, dataDir };
}

function intent(amount_minor: bigint, overrides: Partial<Intent> = {}): Intent {
  return {
    merchant: { domain: "amazon.com" },
    amount: { amount_minor, currency: "USD" },
    type: "one_time",
    ...overrides
  };
}

describe("PolicyEngine.proposeIntent", () => {
  it("allows a matching intent, mints once, and returns an engine-scoped credential id", async () => {
    const { engine, rail } = await makeEngine();
    const request = { caller_token: engine.callerToken(), idempotency_key: "k1", intent: intent(5000n) };

    const first = await engine.proposeIntent(request);
    const second = await engine.proposeIntent(request);

    expect(first.decision).toBe("allow");
    expect(second).toEqual(first);
    expect(rail.mintCount).toBe(1);
    if (first.decision !== "allow") throw new Error("expected allow");
    expect(first.credential.credential_id).toMatch(/^cred_[0-9a-f-]{36}$/);
    expect(first.credential.authorization_hash).toBe(first.authorization_hash);
    expect(rail.minted[0]).toMatchObject({ authorization_hash: first.authorization_hash, constraints_amount_minor: 5000n });
  });

  it("denies no-match intents and enforces rolling per-day and per-purchase caps", async () => {
    const { engine } = await makeEngine();
    const caller_token = engine.callerToken();

    await expect(
      engine.proposeIntent({
        caller_token,
        idempotency_key: "unknown",
        intent: intent(5000n, { merchant: { domain: "unknown.example" } })
      })
    ).resolves.toMatchObject({ decision: "deny", matched_rule: "deny-all" });

    for (let i = 0; i < 3; i += 1) {
      await expect(engine.proposeIntent({ caller_token, idempotency_key: `cap-${i}`, intent: intent(10000n) })).resolves.toMatchObject({
        decision: "allow"
      });
    }
    await expect(engine.proposeIntent({ caller_token, idempotency_key: "cap-4", intent: intent(10000n) })).resolves.toMatchObject({
      decision: "deny",
      reason_code: "limit:per_day_usd"
    });

    const { engine: purchaseEngine } = await makeEngine();
    const purchaseToken = purchaseEngine.callerToken();
    await expect(
      purchaseEngine.proposeIntent({ caller_token: purchaseToken, idempotency_key: "p1", intent: intent(10000n, { purchase_id: "po_1" }) })
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      purchaseEngine.proposeIntent({ caller_token: purchaseToken, idempotency_key: "p2", intent: intent(10000n, { purchase_id: "po_1" }) })
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      purchaseEngine.proposeIntent({ caller_token: purchaseToken, idempotency_key: "p3", intent: intent(10000n, { purchase_id: "po_1" }) })
    ).resolves.toMatchObject({ decision: "deny", reason_code: "limit:per_purchase_usd" });
  });

  it("rejects unauthenticated calls, missing idempotency keys, and rail environment mismatch", async () => {
    const { engine } = await makeEngine();
    await expect(engine.capabilities({ caller_token: "bad" })).rejects.toThrow(/unauthenticated/);
    await expect(engine.proposeIntent({ caller_token: engine.callerToken(), idempotency_key: "", intent: intent(5000n) })).rejects.toThrow(
      /idempotency_key/
    );

    const { engine: prodEngine } = await makeEngine({ env: "production" });
    await expect(
      prodEngine.proposeIntent({ caller_token: prodEngine.callerToken(), idempotency_key: "env", intent: intent(5000n) })
    ).resolves.toMatchObject({ decision: "deny", reason_code: "rail_env_mismatch" });
  });

  it("loads and reloads policies from policyPath", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "engine-file-"));
    const policyPath = join(dataDir, "policy.yaml");
    writeFileSync(policyPath, POLICY);
    const { engine } = await makeEngine({ policyPath });
    const caller_token = engine.callerToken();

    const first = await engine.capabilities({ caller_token });
    writeFileSync(policyPath, RELOADED_POLICY);
    const reloaded = await engine.reloadPolicy();
    const second = await engine.capabilities({ caller_token });

    expect(first.policy_hash).toMatch(/^sha256:/);
    expect(reloaded.policy_hash).toBe(second.policy_hash);
    await expect(engine.proposeIntent({ caller_token, idempotency_key: "after-file-reload", intent: intent(5000n) })).resolves.toMatchObject({
      decision: "deny",
      matched_rule: "deny-amazon"
    });
  });

  it("maps public credential ids to rail ids for revoke and settlement ack", async () => {
    const { engine, rail } = await makeEngine();
    const caller_token = engine.callerToken();
    const allowed = await engine.proposeIntent({ caller_token, idempotency_key: "cred", intent: intent(5000n) });
    if (allowed.decision !== "allow") throw new Error("expected allow");

    await expect(engine.getApprovalStatus({ caller_token, intent_id: allowed.intent_id })).resolves.toMatchObject({
      status: "approved",
      credential: allowed.credential
    });
    await engine.revokeCredential({ caller_token, credential_id: allowed.credential.credential_id });
    await engine.ackSettlement({ caller_token, credential_id: allowed.credential.credential_id, event_id: "evt_1" });
    await expect(engine.revokeCredential({ caller_token: "bad", credential_id: allowed.credential.credential_id })).rejects.toThrow(/unauthenticated/);

    expect(rail.revoked).toEqual([expect.stringMatching(/^rail_/)]);
    expect(rail.acked).toEqual([{ credential_id: rail.revoked[0], event_id: "evt_1" }]);
    expect(engine.observeCredential(allowed.credential.credential_id)[Symbol.asyncIterator]).toBeTypeOf("function");
    expect(() => engine.observeCredential("cred_missing")).toThrow(/credential not found/);
    await expect(engine.ackSettlement({ caller_token, credential_id: "cred_missing", event_id: "evt_missing" })).rejects.toThrow(/credential not found/);
  });

  it("amends the audit log with observed settlement events on ack", async () => {
    const rail = fakeCardAdapter();
    const { engine, dataDir } = await makeEngine({ rail });
    const caller_token = engine.callerToken();
    const allowed = await engine.proposeIntent({ caller_token, idempotency_key: "settlement", intent: intent(5000n) });
    if (allowed.decision !== "allow") throw new Error("expected allow");
    rail.events.push({
      event_id: "evt_captured",
      ts: "2026-06-28T12:00:05.000Z",
      kind: "captured",
      amount_minor: 5000n,
      currency: "USD"
    });

    await engine.ackSettlement({ caller_token, credential_id: allowed.credential.credential_id, event_id: "evt_captured" });

    const audit = readFileSync(join(dataDir, "audit", "2026-06-28.jsonl"), "utf8");
    expect(audit).toContain('"settlement_events"');
    expect(audit).toContain('"evt_captured"');
  });

  it("releases reservations when rail minting fails", async () => {
    const failingRail = fakeCardAdapter({ failMint: true });
    const { engine } = await makeEngine({ rail: failingRail });
    const caller_token = engine.callerToken();

    await expect(engine.proposeIntent({ caller_token, idempotency_key: "fail-1", intent: intent(10000n) })).rejects.toThrow(/mint failed/);

    const workingRail = fakeCardAdapter();
    const { engine: workingEngine } = await makeEngine({ rail: workingRail });
    const workingToken = workingEngine.callerToken();
    await expect(workingEngine.proposeIntent({ caller_token: workingToken, idempotency_key: "ok-1", intent: intent(10000n) })).resolves.toMatchObject({
      decision: "allow"
    });
  });

  it("rejects rail credentials bound to a different authorization hash", async () => {
    const rail = fakeCardAdapter({ mismatchAuth: true });
    const { engine } = await makeEngine({ rail });

    await expect(engine.proposeIntent({ caller_token: engine.callerToken(), idempotency_key: "mismatch", intent: intent(5000n) })).rejects.toThrow(
      /different authorization_hash/
    );
  });
});

describe("PolicyEngine approval race ledger", () => {
  it("lets a pending approval complete after the budget is exhausted and rejects replayed callbacks", async () => {
    const { engine, approvals, rail } = await makeEngine({ approvalBudgetMax: 1 });
    const caller_token = engine.callerToken();

    const pending = await engine.proposeIntent({ caller_token, idempotency_key: "ap-1", intent: intent(15000n) });
    const exhausted = await engine.proposeIntent({ caller_token, idempotency_key: "ap-2", intent: intent(15000n) });

    expect(pending.decision).toBe("pending_approval");
    expect(exhausted).toMatchObject({ decision: "deny", reason_code: "approval_budget_exhausted" });
    if (pending.decision !== "pending_approval") throw new Error("expected pending");

    const prompt = approvals.prompts[0];
    expect(prompt.prompt_text).not.toContain("agent rationale");
    const approved = await engine.handleApprovalCallback({
      approval_prompt_id: pending.approval_prompt_id,
      nonce: prompt.nonce,
      decision: "approve",
      policy_hash: pending.policy_hash
    });
    const replay = await engine.handleApprovalCallback({
      approval_prompt_id: pending.approval_prompt_id,
      nonce: prompt.nonce,
      decision: "approve",
      policy_hash: pending.policy_hash
    });

    expect(approved).toMatchObject({ ok: true, status: "approved" });
    expect(replay).toMatchObject({ ok: false, status_code: 409, reason: "replayed_nonce" });
    expect(rail.mintCount).toBe(1);
    await expect(engine.getApprovalStatus({ caller_token, intent_id: pending.intent_id })).resolves.toMatchObject({ status: "approved" });
  });

  it("expires late callbacks and writes an expired audit entry", async () => {
    const { engine, approvals, clock, dataDir } = await makeEngine();
    const caller_token = engine.callerToken();
    const pending = await engine.proposeIntent({ caller_token, idempotency_key: "late", intent: intent(15000n) });
    if (pending.decision !== "pending_approval") throw new Error("expected pending");

    clock.advance(6 * 60 * 1000);
    const late = await engine.handleApprovalCallback({
      approval_prompt_id: pending.approval_prompt_id,
      nonce: approvals.prompts[0].nonce,
      decision: "approve",
      policy_hash: pending.policy_hash
    });

    expect(late).toMatchObject({ ok: false, status_code: 410, reason: "expired" });
    await expect(engine.getApprovalStatus({ caller_token, intent_id: pending.intent_id })).resolves.toMatchObject({ status: "expired" });
    const audit = readFileSync(join(dataDir, "audit", "2026-06-28.jsonl"), "utf8");
    expect(audit).toContain('"decision":"expired"');
  });

  it("invalidates callbacks after cancelIntent", async () => {
    const { engine, approvals } = await makeEngine();
    const caller_token = engine.callerToken();
    const pending = await engine.proposeIntent({ caller_token, idempotency_key: "cancel", intent: intent(15000n) });
    if (pending.decision !== "pending_approval") throw new Error("expected pending");

    await engine.cancelIntent({ caller_token, intent_id: pending.intent_id });
    const callback = await engine.handleApprovalCallback({
      approval_prompt_id: pending.approval_prompt_id,
      nonce: approvals.prompts[0].nonce,
      decision: "approve",
      policy_hash: pending.policy_hash
    });

    expect(callback).toMatchObject({ ok: false, status_code: 410, reason: "cancelled" });
    await expect(engine.getApprovalStatus({ caller_token, intent_id: pending.intent_id })).resolves.toMatchObject({
      status: "denied",
      reason_code: "cancelled"
    });
  });

  it("handles denied, malformed, unknown, and nonce-mismatched callbacks", async () => {
    const { engine, approvals } = await makeEngine();
    const caller_token = engine.callerToken();
    const pending = await engine.proposeIntent({ caller_token, idempotency_key: "deny", intent: intent(15000n) });
    if (pending.decision !== "pending_approval") throw new Error("expected pending");

    await expect(engine.handleApprovalCallback({ approval_prompt_id: "", nonce: "", decision: "approve" })).resolves.toMatchObject({
      ok: false,
      status_code: 400,
      reason: "invalid_body"
    });
    await expect(
      engine.handleApprovalCallback({ approval_prompt_id: "ap_missing", nonce: "nonce", decision: "approve" })
    ).resolves.toMatchObject({ ok: false, status_code: 404, reason: "unknown_prompt" });
    await expect(
      engine.handleApprovalCallback({ approval_prompt_id: pending.approval_prompt_id, nonce: "wrong", decision: "approve" })
    ).resolves.toMatchObject({ ok: false, status_code: 400, reason: "nonce_mismatch" });

    const denied = await engine.handleApprovalCallback({
      approval_prompt_id: pending.approval_prompt_id,
      nonce: approvals.prompts[0].nonce,
      decision: "deny",
      policy_hash: pending.policy_hash
    });

    expect(denied).toMatchObject({ ok: true, status_code: 200, status: "denied" });
    await expect(engine.getApprovalStatus({ caller_token, intent_id: pending.intent_id })).resolves.toMatchObject({
      status: "denied",
      reason_code: "user_denied"
    });
  });

  it("denies approval rules fail-closed when no approval channel is configured", async () => {
    const clock = new MutableClock();
    const dataDir = mkdtempSync(join(tmpdir(), "engine-"));
    const engine = new PolicyEngine({
      dataDir,
      clock,
      fx: new InMemoryFxQuoteService({}, () => clock.now()),
      rails: [fakeCardAdapter()],
      policyYaml: POLICY
    });
    await engine.start();
    engines.push(engine);

    await expect(engine.proposeIntent({ caller_token: engine.callerToken(), idempotency_key: "no-channel", intent: intent(15000n) })).resolves.toMatchObject({
      decision: "deny",
      reason_code: "approval_channel_missing"
    });
  });

  it("honors second-based approval expiry and rejects missing snapshot metadata", async () => {
    const oneSecondPolicy = POLICY.replace("expires_in: 5m", "expires_in: 1s");
    const { engine } = await makeEngine({ policyYaml: oneSecondPolicy });
    const caller_token = engine.callerToken();

    const pending = await engine.proposeIntent({ caller_token, idempotency_key: "one-second", intent: intent(15000n) });

    expect(pending).toMatchObject({ decision: "pending_approval", expires_at: "2026-06-28T12:00:01.000Z" });
    await expect(engine.getPolicySnapshot({ caller_token, policy_hash: "sha256:missing" })).rejects.toThrow(/policy snapshot not found/);
  });

  it("rejects approval after policy reload and applies the new policy to subsequent proposals", async () => {
    const { engine, approvals } = await makeEngine();
    const caller_token = engine.callerToken();
    const pending = await engine.proposeIntent({ caller_token, idempotency_key: "reload-pending", intent: intent(15000n) });
    if (pending.decision !== "pending_approval") throw new Error("expected pending");

    await engine.reloadPolicy(RELOADED_POLICY);
    const oldSnapshot = await engine.getPolicySnapshot({ caller_token, policy_hash: pending.policy_hash });
    const newDecision = await engine.proposeIntent({ caller_token, idempotency_key: "reload-new", intent: intent(15000n) });
    const stale = await engine.handleApprovalCallback({
      approval_prompt_id: pending.approval_prompt_id,
      nonce: approvals.prompts[0].nonce,
      decision: "approve",
      policy_hash: pending.policy_hash
    });

    expect(oldSnapshot).toEqual({
      policy_hash: pending.policy_hash,
      version: "2026-06-27",
      loaded_at: "2026-06-28T12:00:00.000Z",
      rule_names: ["trusted-small", "needs-approval", "deny-all"],
      current: false
    });
    expect(Object.keys(oldSnapshot).sort()).toEqual(["current", "loaded_at", "policy_hash", "rule_names", "version"]);
    expect(newDecision).toMatchObject({ decision: "deny", matched_rule: "deny-amazon" });
    expect(stale).toMatchObject({ ok: false, status_code: 409, reason: "policy_snapshot_stale" });
  });
});

describe("PolicyEngine IPC composition", () => {
  it("serves capabilities over the JSON-RPC socket", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "engine-"));
    const socketPath = join(dataDir, "policy.sock");
    const { engine } = await makeEngine({ socketPath });

    const response = (await rpc(socketPath, "capabilities", { caller_token: engine.callerToken() })) as {
      result?: { rails_enabled: string[]; engine_version: string; policy_hash: string };
    };

    expect(response.result?.rails_enabled).toEqual(["virtual_card"]);
    expect(response.result?.engine_version).toBe("0.0.0");
    expect(response.result?.policy_hash).toMatch(/^sha256:/);
  });
});

function rpc(socketPath: string, method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.endsWith("\n")) return;
      conn.end();
      resolve(JSON.parse(buffer));
    });
    conn.on("error", reject);
    conn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
  });
}
