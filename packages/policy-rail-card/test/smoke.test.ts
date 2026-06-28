import { describe, expect, it } from "vitest";
import { VirtualCardPolicyRailAdapter, virtualCardRail } from "../src/index.js";
import { WebhookEventBus } from "../src/observe.js";

describe("scaffold", () => {
  it("exports VirtualCardPolicyRailAdapter", () => {
    const adapter = new VirtualCardPolicyRailAdapter({
      stripe: stripeFake(),
      cardholderId: "ich_user",
      env: "sandbox",
      webhookBus: new WebhookEventBus()
    });
    expect(adapter.name).toBe("virtual_card");
    expect(adapter.capabilities().rails_supported).toEqual(["virtual_card"]);
  });

  it("exports a fully assembled policy rail factory", async () => {
    const adapter = virtualCardRail({
      stripe: stripeFake(),
      cardholderId: "ich_user",
      env: "sandbox",
      webhookBus: new WebhookEventBus()
    });

    await expect(adapter.ackSettlement("cred_1", "evt_1")).resolves.toBeUndefined();
    expect(adapter).toBeInstanceOf(VirtualCardPolicyRailAdapter);
  });

  it("exports VirtualCardPolicyRailAdapter for explicit class-based wiring", () => {
    const adapter = new VirtualCardPolicyRailAdapter({
      stripe: stripeFake(),
      cardholderId: "ich_user",
      env: "sandbox",
      webhookBus: new WebhookEventBus()
    });

    expect(adapter).toBeInstanceOf(VirtualCardPolicyRailAdapter);
    expect(adapter.name).toBe("virtual_card");
  });
});

function stripeFake() {
  return { issuing: { cards: { create: async () => ({ id: "ic_fake" }), update: async () => ({ id: "ic_fake" }) } } } as never;
}
