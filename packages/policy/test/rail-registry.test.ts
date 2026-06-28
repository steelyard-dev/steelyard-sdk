import { describe, expect, it } from "vitest";
import type { PolicyRailAdapter } from "../src/rail/adapter.js";
import { RailRegistry } from "../src/rail/registry.js";

const fakeAdapter: PolicyRailAdapter = {
  name: "virtual_card",
  enforcement_level: "network_enforced",
  loss_ceiling_source: "per_credential",
  caveats: ["test only"],
  env: "sandbox",
  capabilities: () => ({ rails_supported: ["virtual_card"], availability_signal_source: "test" }),
  mint: async () => {
    throw new Error("not used");
  },
  observe: async function* () {},
  revoke: async () => {},
  ackSettlement: async () => {}
};

describe("RailRegistry", () => {
  it("registers and retrieves by name", () => {
    const registry = new RailRegistry();
    registry.register(fakeAdapter);
    expect(registry.get("virtual_card").enforcement_level).toBe("network_enforced");
  });

  it("lists registered adapters", () => {
    const registry = new RailRegistry();
    registry.register(fakeAdapter);
    expect(registry.list()).toEqual([fakeAdapter]);
  });

  it("rejects double-registration", () => {
    const registry = new RailRegistry();
    registry.register(fakeAdapter);
    expect(() => registry.register(fakeAdapter)).toThrow(/already registered/);
  });

  it("rejects lookup for unregistered rail", () => {
    const registry = new RailRegistry();
    expect(() => registry.get("virtual_card")).toThrow(/not registered/);
  });
});
