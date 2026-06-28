import { describe, expect, it } from "vitest";
import { InMemoryFxQuoteService, PolicyEngine, createPolicyEngine } from "../src/index.js";

const now = new Date("2026-06-14T12:00:00.000Z");

describe("developer-facing policy names", () => {
  it("creates a PolicyEngine through the factory name", () => {
    const engine = createPolicyEngine({
      dataDir: "/tmp/steelyard-policy-dx-test",
      clock: { now: () => now },
      fx: new InMemoryFxQuoteService({}, () => now),
      rails: [],
      policyYaml: "version: '0.1'\ndefault: deny\nrules: []\n"
    });

    expect(engine).toBeInstanceOf(PolicyEngine);
  });
});
