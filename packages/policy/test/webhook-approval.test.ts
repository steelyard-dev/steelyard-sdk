import { describe, expect, it, vi } from "vitest";
import { signWebhookBody, verifyCallback, WebhookApprovalChannel } from "../src/approval/webhook.js";
import type { ApprovalPrompt } from "../src/approval/channel.js";

const prompt: ApprovalPrompt = {
  approval_prompt_id: "ap_1",
  nonce: "nonce_1",
  policy_hash: "sha256:p",
  authorization_hash: "sha256:a",
  prompt_text: "Approve $50 to amazon.com?",
  agent_rationale_quarantined: "untrusted summary",
  expires_at: "2026-06-28T12:05:00.000Z"
};

describe("WebhookApprovalChannel", () => {
  it("POSTs an HMAC-signed body to the configured URL", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const channel = new WebhookApprovalChannel({
      url: "https://example.test/approve",
      hmac_secret: "secret",
      fetch: fetchMock,
      now: () => new Date("2026-06-28T12:00:00Z")
    });

    await expect(channel.prompt(prompt)).resolves.toEqual({ approval_prompt_id: "ap_1", nonce: "nonce_1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-steelyard-signature"]).toMatch(/^sha256=/);
    expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("agent_rationale");
  });

  it("throws when the approval webhook POST fails", async () => {
    const channel = new WebhookApprovalChannel({
      url: "https://example.test/approve",
      hmac_secret: "secret",
      fetch: vi.fn(async () => new Response("", { status: 500 }))
    });
    await expect(channel.prompt(prompt)).rejects.toThrow(/HTTP 500/);
  });

  it("verifyCallback rejects wrong signature", () => {
    const body = callbackBody();
    expect(verifyCallback({ body, signature: "sha256=bogus", secret: "secret" })).toBe(false);
  });

  it("verifyCallback accepts correct signature", () => {
    const body = callbackBody();
    expect(verifyCallback({ body, signature: signWebhookBody(body, "secret"), secret: "secret" })).toBe(true);
  });

  it("accepts a signed approval callback and updates status", async () => {
    const channel = await channelWithPrompt();
    const body = callbackBody();
    expect(channel.handleCallback({ body, signature: signWebhookBody(body, "secret"), current_policy_hash: "sha256:p" })).toEqual({
      ok: true,
      status: "approved"
    });
    await expect(channel.status("ap_1")).resolves.toBe("approved");
  });

  it("accepts a signed denial callback", async () => {
    const channel = await channelWithPrompt();
    const body = callbackBody({ decision: "deny" });
    expect(channel.handleCallback({ body, signature: signWebhookBody(body, "secret") })).toEqual({ ok: true, status: "denied" });
  });

  it("rejects callback replay, unknown prompt, nonce mismatch, stale policy, expired prompt, and invalid body", async () => {
    const channel = await channelWithPrompt();
    const approved = callbackBody();
    expect(channel.handleCallback({ body: approved, signature: signWebhookBody(approved, "secret") }).ok).toBe(true);
    expect(channel.handleCallback({ body: approved, signature: signWebhookBody(approved, "secret") })).toEqual({
      ok: false,
      reason: "replayed_nonce"
    });

    const unknown = callbackBody({ approval_prompt_id: "ap_missing" });
    expect(channel.handleCallback({ body: unknown, signature: signWebhookBody(unknown, "secret") })).toEqual({
      ok: false,
      reason: "unknown_prompt"
    });

    const wrongNonceChannel = await channelWithPrompt();
    const wrongNonce = callbackBody({ nonce: "wrong" });
    expect(wrongNonceChannel.handleCallback({ body: wrongNonce, signature: signWebhookBody(wrongNonce, "secret") })).toEqual({
      ok: false,
      reason: "nonce_mismatch"
    });

    const stalePolicyChannel = await channelWithPrompt();
    const stalePolicy = callbackBody({ policy_hash: "sha256:old" });
    expect(stalePolicyChannel.handleCallback({ body: stalePolicy, signature: signWebhookBody(stalePolicy, "secret"), current_policy_hash: "sha256:new" })).toEqual({
      ok: false,
      reason: "policy_snapshot_stale"
    });

    const expiredChannel = await channelWithPrompt(() => new Date("2026-06-28T12:06:00Z"));
    const expired = callbackBody();
    expect(expiredChannel.handleCallback({ body: expired, signature: signWebhookBody(expired, "secret") })).toEqual({
      ok: false,
      reason: "expired"
    });

    expect(channel.handleCallback({ body: "not-json", signature: signWebhookBody("not-json", "secret") })).toEqual({
      ok: false,
      reason: "invalid_body"
    });
  });
});

async function channelWithPrompt(now: () => Date = () => new Date("2026-06-28T12:00:00Z")): Promise<WebhookApprovalChannel> {
  const channel = new WebhookApprovalChannel({
    url: "https://example.test/approve",
    hmac_secret: "secret",
    fetch: vi.fn(async () => new Response("", { status: 202 })),
    now
  });
  await channel.prompt(prompt);
  return channel;
}

function callbackBody(
  overrides: Partial<{ approval_prompt_id: string; nonce: string; decision: "approve" | "deny"; policy_hash: string }> = {}
): string {
  return JSON.stringify({
    approval_prompt_id: "ap_1",
    nonce: "nonce_1",
    decision: "approve",
    policy_hash: "sha256:p",
    ...overrides
  });
}
