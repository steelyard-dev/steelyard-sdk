import { describe, expect, it, vi } from "vitest";
import type { PolicyRailAdapter } from "@steelyard/policy";
import { VirtualCardPolicyRailAdapter } from "../src/adapter.js";
import { WebhookEventBus } from "../src/observe.js";
import { revokeCard } from "../src/revoke.js";

describe("revokeCard", () => {
  it("cancels the Stripe Issuing card", async () => {
    const stripe = { issuing: { cards: { update: vi.fn(async () => ({ id: "ic_1" })) } } };

    await revokeCard(stripe as unknown as Parameters<typeof revokeCard>[0], "ic_1");

    expect(stripe.issuing.cards.update).toHaveBeenCalledWith("ic_1", { status: "canceled" });
  });
});

describe("VirtualCardPolicyRailAdapter", () => {
  it("implements PolicyRailAdapter metadata, observe, revoke, and ack", async () => {
    const stripe = {
      issuing: {
        cards: {
          create: vi.fn(async () => ({ id: "ic_created" })),
          update: vi.fn(async () => ({ id: "ic_created" }))
        }
      }
    };
    const webhookBus = new WebhookEventBus();
    webhookBus.ingest({ id: "evt_1", type: "issuing_transaction.created", created: 1000, data: { object: { card: "ic_created", amount: 1000 } } });
    const adapter: PolicyRailAdapter = new VirtualCardPolicyRailAdapter({
      stripe: stripe as unknown as ConstructorParameters<typeof VirtualCardPolicyRailAdapter>[0]["stripe"],
      cardholderId: "ich_user",
      env: "production",
      webhookBus
    });

    const observed = [];
    for await (const event of adapter.observe("ic_created")) observed.push(event);
    await adapter.revoke("ic_created");
    await expect(adapter.ackSettlement("ic_created", "evt_1")).resolves.toBeUndefined();

    expect(adapter.name).toBe("virtual_card");
    expect(adapter.enforcement_level).toBe("network_enforced");
    expect(adapter.loss_ceiling_source).toBe("per_credential");
    expect(adapter.caveats.join(" ")).toContain("MID best-effort");
    expect(adapter.env).toBe("production");
    expect(adapter.capabilities()).toEqual({ rails_supported: ["virtual_card"], availability_signal_source: "stripe_issuing" });
    expect(observed).toEqual([expect.objectContaining({ event_id: "evt_1", kind: "captured" })]);
    expect(stripe.issuing.cards.update).toHaveBeenCalledWith("ic_created", { status: "canceled" });
  });
});
