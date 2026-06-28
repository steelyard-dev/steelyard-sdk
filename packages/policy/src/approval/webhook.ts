import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApprovalChannel, ApprovalPrompt, ApprovalStatus } from "./channel.js";

export type ApprovalCallbackDecision = "approve" | "deny";

export interface ApprovalCallbackBody {
  approval_prompt_id: string;
  nonce: string;
  decision: ApprovalCallbackDecision;
  policy_hash?: string;
}

export type ApprovalCallbackResult =
  | { ok: true; status: "approved" | "denied" }
  | {
      ok: false;
      reason:
        | "signature_mismatch"
        | "invalid_body"
        | "unknown_prompt"
        | "nonce_mismatch"
        | "replayed_nonce"
        | "expired"
        | "policy_snapshot_stale";
    };

export type WebhookApprovalCallbackResult = ApprovalCallbackResult;

export interface WebhookApprovalChannelOptions {
  url: string;
  hmac_secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface StoredPrompt {
  prompt: ApprovalPrompt;
  status: ApprovalStatus;
}

export class WebhookApprovalChannel implements ApprovalChannel {
  private readonly prompts = new Map<string, StoredPrompt>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: WebhookApprovalChannelOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  async prompt(req: ApprovalPrompt): Promise<{ approval_prompt_id: string; nonce: string }> {
    const body = JSON.stringify(req);
    const signature = signWebhookBody(body, this.opts.hmac_secret);
    const response = await this.fetchImpl(this.opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-steelyard-signature": signature },
      body
    });
    if (!response.ok) throw new Error(`approval webhook POST failed HTTP ${response.status}`);
    this.prompts.set(req.approval_prompt_id, { prompt: req, status: "pending" });
    return { approval_prompt_id: req.approval_prompt_id, nonce: req.nonce };
  }

  async status(id: string): Promise<ApprovalStatus> {
    const stored = this.prompts.get(id);
    if (!stored) return "expired";
    return this.statusFor(stored);
  }

  handleCallback(args: { body: string; signature: string; current_policy_hash?: string }): ApprovalCallbackResult {
    if (!verifyCallback({ body: args.body, signature: args.signature, secret: this.opts.hmac_secret })) {
      return { ok: false, reason: "signature_mismatch" };
    }

    const parsed = parseCallbackBody(args.body);
    if (!parsed) return { ok: false, reason: "invalid_body" };

    const stored = this.prompts.get(parsed.approval_prompt_id);
    if (!stored) return { ok: false, reason: "unknown_prompt" };
    if (stored.prompt.nonce !== parsed.nonce) return { ok: false, reason: "nonce_mismatch" };
    if (stored.status === "approved" || stored.status === "denied") return { ok: false, reason: "replayed_nonce" };
    if (this.statusFor(stored) === "expired") return { ok: false, reason: "expired" };
    if (args.current_policy_hash && parsed.policy_hash && parsed.policy_hash !== args.current_policy_hash) {
      return { ok: false, reason: "policy_snapshot_stale" };
    }

    const status = parsed.decision === "approve" ? "approved" : "denied";
    stored.status = status;
    return { ok: true, status };
  }

  private statusFor(stored: StoredPrompt): ApprovalStatus {
    if (stored.status === "pending" && Date.parse(stored.prompt.expires_at) <= this.now().getTime()) {
      stored.status = "expired";
    }
    return stored.status;
  }
}

export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyCallback(args: { body: string; signature: string; secret: string }): boolean {
  const expected = signWebhookBody(args.body, args.secret);
  const provided = Buffer.from(args.signature);
  const target = Buffer.from(expected);
  if (provided.length !== target.length) return false;
  return timingSafeEqual(provided, target);
}

function parseCallbackBody(body: string): ApprovalCallbackBody | undefined {
  try {
    const parsed = JSON.parse(body) as Partial<ApprovalCallbackBody>;
    if (typeof parsed.approval_prompt_id !== "string" || !parsed.approval_prompt_id) return undefined;
    if (typeof parsed.nonce !== "string" || !parsed.nonce) return undefined;
    if (parsed.decision !== "approve" && parsed.decision !== "deny") return undefined;
    if (parsed.policy_hash !== undefined && typeof parsed.policy_hash !== "string") return undefined;
    return {
      approval_prompt_id: parsed.approval_prompt_id,
      nonce: parsed.nonce,
      decision: parsed.decision,
      ...(parsed.policy_hash ? { policy_hash: parsed.policy_hash } : {})
    };
  } catch {
    return undefined;
  }
}
