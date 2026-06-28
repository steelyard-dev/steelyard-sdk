import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(packageRoot, "spec", "policy", "0.1", "policy.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

describe("policy schema", () => {
  it("accepts a minimal valid policy", () => {
    expect(validate({ version: "2026-06-27", rules: [{ name: "default-deny", do: "deny" }] })).toBe(true);
  });

  it("accepts representative v1 policy fields", () => {
    expect(
      validate({
        version: "2026-06-27",
        trusted_domains: { tier1: ["amazon.com", "target.com"] },
        blocked_domains: ["temu.com"],
        rules: [
          {
            name: "trusted-small",
            do: "allow",
            rail: "virtual_card",
            when: {
              merchant_domain_in: "tier1",
              amount_usd: { min: 1, max: 100 },
              type: ["one_time", "installment"],
              cart_contains: ["book"],
              merchant_supports: "ucp_acp",
              merchant_signature: "verified",
              tls: "required"
            },
            limits: { per_day_usd: 300, per_day_count: 5, per_purchase_usd: 100 },
            approval: { who: "user", channel: "webhook", expires_in: "5m", include_in_prompt: ["merchant", "amount"] }
          }
        ]
      })
    ).toBe(true);
  });

  it("rejects unknown version", () => {
    expect(validate({ version: "1999-01-01", rules: [{ name: "x", do: "deny" }] })).toBe(false);
  });

  it("rejects unknown rail", () => {
    expect(validate({ version: "2026-06-27", rules: [{ name: "x", do: "allow", rail: "ach" }] })).toBe(false);
  });

  it("rejects unknown when field", () => {
    expect(validate({ version: "2026-06-27", rules: [{ name: "x", do: "deny", when: { rng: 0.5 } }] })).toBe(false);
  });

  it("rejects additional top-level and rule fields", () => {
    expect(validate({ version: "2026-06-27", owner: "alice", rules: [{ name: "x", do: "deny" }] })).toBe(false);
    expect(validate({ version: "2026-06-27", rules: [{ name: "x", do: "deny", rail_options: ["virtual_card"] }] })).toBe(
      false
    );
  });

  it("rejects malformed domains and approval expiry", () => {
    expect(validate({ version: "2026-06-27", trusted_domains: { bad: ["https://amazon.com"] }, rules: [{ name: "x", do: "deny" }] })).toBe(
      false
    );
    expect(
      validate({
        version: "2026-06-27",
        rules: [{ name: "x", do: "require_approval", approval: { who: "user", channel: "webhook", expires_in: "soon" } }]
      })
    ).toBe(false);
  });
});
