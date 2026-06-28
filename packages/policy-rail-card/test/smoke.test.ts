import { describe, expect, it } from "vitest";
import { CardRailAdapter } from "../src/index.js";
import { WebhookEventBus } from "../src/observe.js";

describe("scaffold", () => {
  it("exports CardRailAdapter", () => {
    const adapter = new CardRailAdapter({
      stripe: stripeFake(),
      cardholderId: "ich_user",
      env: "sandbox",
      webhookBus: new WebhookEventBus()
    });
    expect(adapter.name).toBe("virtual_card");
    expect(adapter.capabilities().rails_supported).toEqual(["virtual_card"]);
  });

  it("exports a fully assembled adapter", async () => {
    const adapter = new CardRailAdapter({
      stripe: stripeFake(),
      cardholderId: "ich_user",
      env: "sandbox",
      webhookBus: new WebhookEventBus()
    });

    await expect(adapter.ackSettlement("cred_1", "evt_1")).resolves.toBeUndefined();
  });
});

function stripeFake() {
  return { issuing: { cards: { create: async () => ({ id: "ic_fake" }), update: async () => ({ id: "ic_fake" }) } } } as never;
}
