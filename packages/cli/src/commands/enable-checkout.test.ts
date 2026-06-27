// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runEnableCheckout } from "./enable-checkout.js";
import type { CliIO } from "../io.js";

function io(cwd: string): CliIO {
  return {
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    stdout: Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    env: { CI: "1", STRIPE_SECRET_KEY: "sk_test_xxx" },
    cwd
  };
}

describe("runEnableCheckout", () => {
  it("verifies the key, augments the manifest, sets tier=b", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sy-enable-"));
    writeFileSync(
      join(cwd, "commerce.ts"),
      `import { defineCommerce } from "steelyard";\nexport default defineCommerce({ identity: { name: "X", domain: "x", currencies: ["USD"] }, offers: [] });\n`
    );
    writeFileSync(join(cwd, ".env.local"), "");
    const stripeFactory = () => ({
      accounts: { retrieve: async () => ({ id: "acct_123", livemode: false }) }
    });
    const result = await runEnableCheckout({ yes: true }, io(cwd), { stripeFactory: stripeFactory as any });
    expect(result.code).toBe(0);
    expect(readFileSync(join(cwd, ".env.local"), "utf8")).toContain("STEELYARD_TIER=b");
  });

  it("fails gracefully when no Stripe key available", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sy-enable-"));
    writeFileSync(join(cwd, "commerce.ts"), "");
    const noKeyIo: CliIO = { ...io(cwd), env: { CI: "1" } };
    const result = await runEnableCheckout({ yes: true }, noKeyIo, { stripeFactory: (() => ({})) as any });
    expect(result.code).not.toBe(0);
  });

  it("returns exit code 1 when Stripe verification throws", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sy-enable-"));
    const stripeFactory = () => ({
      accounts: {
        retrieve: async () => {
          throw new Error("invalid key");
        }
      }
    });
    const result = await runEnableCheckout({ yes: true }, io(cwd), { stripeFactory: stripeFactory as any });
    expect(result.code).toBe(1);
  });

  it("replaces an existing STEELYARD_TIER line instead of appending", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sy-enable-"));
    writeFileSync(join(cwd, ".env.local"), "STEELYARD_TIER=a\nFOO=bar\n");
    const stripeFactory = () => ({
      accounts: { retrieve: async () => ({ id: "acct_456", livemode: true }) }
    });
    const result = await runEnableCheckout({ yes: true }, io(cwd), { stripeFactory: stripeFactory as any });
    expect(result.code).toBe(0);
    const env = readFileSync(join(cwd, ".env.local"), "utf8");
    expect(env).toContain("STEELYARD_TIER=b");
    expect(env).not.toContain("STEELYARD_TIER=a");
    expect(env).toContain("FOO=bar");
  });

  it("reads the Stripe key from .env.local when env var is unset", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sy-enable-"));
    writeFileSync(join(cwd, ".env.local"), 'STRIPE_SECRET_KEY="sk_test_fromfile"\n');
    const seen: string[] = [];
    const stripeFactory = (k: string) => {
      seen.push(k);
      return { accounts: { retrieve: async () => ({ id: "acct_789", livemode: false }) } };
    };
    const noEnvIo: CliIO = { ...io(cwd), env: { CI: "1" } };
    const result = await runEnableCheckout({ yes: true }, noEnvIo, { stripeFactory: stripeFactory as any });
    expect(result.code).toBe(0);
    expect(seen).toEqual(["sk_test_fromfile"]);
  });
});
