import { describe, expect, it, vi } from "vitest";
import type { PolicyRailAdapter } from "@steelyard-dev/policy";
import { VirtualCardPolicyRailAdapter } from "../src/adapter.js";
import { WebhookEventBus } from "../src/observe.js";
import { mintCard } from "../src/mint.js";

describe("mintCard", () => {
  it("requests a virtual card with locked amount, currency, metadata expiry, and auth-hash idempotency", async () => {
    const issued = {
      id: "ic_abc",
      number: "4242424242424242",
      cvc: "123",
      exp_month: 12,
      exp_year: 2026,
      shipping: { address: { postal_code: "94107" } }
    };
    const stripe = {
      issuing: {
        cards: { create: vi.fn(async () => issued) }
      }
    };

    const card = await mintCard({
      stripe: stripe as unknown as Parameters<typeof mintCard>[0]["stripe"],
      cardholderId: "ich_user",
      authorization_hash: "sha256:abc",
      constraints: { amount_minor: 5000n, currency: "USD", expires_at: "2026-06-29T00:00:00Z" }
    });

    expect(stripe.issuing.cards.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "virtual",
        cardholder: "ich_user",
        currency: "usd",
        status: "active",
        spending_controls: { spending_limits: [{ amount: 5000, interval: "all_time" }] },
        metadata: { authorization_hash: "sha256:abc", steelyard_expires_at: "2026-06-29T00:00:00Z" }
      }),
      expect.objectContaining({ idempotencyKey: "sha256:abc" })
    );
    expect(card).toMatchObject({
      credential_id: "ic_abc",
      authorization_hash: "sha256:abc",
      rail: "virtual_card",
      expires_at: "2026-06-29T00:00:00Z",
      payload: { pan: "4242424242424242", cvv: "123", expiry: "12/2026", billing_zip: "94107" }
    });
  });

  it("passes MCC category controls and rejects unsupported MID locks", async () => {
    const stripe = { issuing: { cards: { create: vi.fn(async () => ({ id: "ic_mcc" })) } } };

    await mintCard({
      stripe: stripe as unknown as Parameters<typeof mintCard>[0]["stripe"],
      cardholderId: "ich_user",
      authorization_hash: "sha256:mcc",
      constraints: {
        amount_minor: 2500n,
        currency: "USD",
        expires_at: "2026-06-29T00:00:00Z",
        mcc_allowed: ["computer_software_stores"]
      }
    });

    expect(stripe.issuing.cards.create).toHaveBeenCalledWith(
      expect.objectContaining({
        spending_controls: expect.objectContaining({ allowed_categories: ["computer_software_stores"] })
      }),
      expect.anything()
    );
    await expect(
      mintCard({
        stripe: stripe as unknown as Parameters<typeof mintCard>[0]["stripe"],
        cardholderId: "ich_user",
        authorization_hash: "sha256:mid",
        constraints: { amount_minor: 2500n, currency: "USD", expires_at: "2026-06-29T00:00:00Z", mid_allowed: ["merchant_123"] }
      })
    ).rejects.toThrow(/MID-locked/);
  });

  it("rejects amounts Stripe cannot safely receive as integer minor units", async () => {
    const stripe = { issuing: { cards: { create: vi.fn() } } };

    await expect(
      mintCard({
        stripe: stripe as unknown as Parameters<typeof mintCard>[0]["stripe"],
        cardholderId: "ich_user",
        authorization_hash: "sha256:huge",
        constraints: { amount_minor: BigInt(Number.MAX_SAFE_INTEGER) + 1n, currency: "USD", expires_at: "2026-06-29T00:00:00Z" }
      })
    ).rejects.toThrow(/safe integer/);
    expect(stripe.issuing.cards.create).not.toHaveBeenCalled();
  });
});

describe("VirtualCardPolicyRailAdapter", () => {
  it("delegates mint to mintCard with configured Stripe dependencies", async () => {
    const stripe = { issuing: { cards: { create: vi.fn(async () => ({ id: "ic_adapter" })) } } };
    const adapter: PolicyRailAdapter = new VirtualCardPolicyRailAdapter({
      stripe: stripe as unknown as Parameters<typeof mintCard>[0]["stripe"],
      cardholderId: "ich_user",
      env: "production",
      webhookBus: new WebhookEventBus()
    });

    const credential = await adapter.mint({
      intent: { merchant: { domain: "example.com" }, amount: { amount_minor: 100n, currency: "USD" }, type: "one_time" },
      constraints: { amount_minor: 100n, currency: "USD", expires_at: "2026-06-29T00:00:00Z" },
      authorization_hash: "sha256:adapter"
    });

    expect(adapter.env).toBe("production");
    expect(credential.credential_id).toBe("ic_adapter");
    expect(stripe.issuing.cards.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "sha256:adapter" });
  });
});
