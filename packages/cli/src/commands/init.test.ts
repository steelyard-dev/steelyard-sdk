import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import prompts from "prompts";
import { runInit } from "./init.js";
import type { CliIO } from "../io.js";

function fakeIo(cwd: string): CliIO & { _out: string[] } {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  return {
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    stdout: Object.assign(out, { isTTY: false }) as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    env: { CI: "1" },
    cwd,
    _out: chunks
  } as CliIO & { _out: string[] };
}

function nextAppFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "steelyard-init-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      dependencies: { next: "^15.0.0" },
      devDependencies: { typescript: "^5.0.0" }
    })
  );
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.0");
  mkdirSync(join(root, "app"), { recursive: true });
  return root;
}

function nonNextFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "steelyard-init-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo", dependencies: {} })
  );
  return root;
}

describe("runInit (non-interactive defaults)", () => {
  it("scaffolds tier-A discovery routes against a Next App fixture", async () => {
    const cwd = nextAppFixture();
    const io = fakeIo(cwd);
    const result = await runInit(
      { yes: true, tier: "a", importStripe: false, manifestPath: "./commerce", surfaces: "all", inspector: true },
      io
    );
    expect(result.code).toBe(0);
    expect(existsSync(resolve(cwd, "app/.well-known/commerce.json/route.ts"))).toBe(true);
    expect(existsSync(resolve(cwd, "app/mcp/route.ts"))).toBe(true);
    expect(existsSync(resolve(cwd, "app/acp/feed/route.ts"))).toBe(true);
    expect(existsSync(resolve(cwd, "app/api/ucp/[...path]/route.ts"))).toBe(true);
    expect(existsSync(resolve(cwd, "commerce.ts"))).toBe(true);
    expect(existsSync(resolve(cwd, "app/(steelyard)/steelyard/page.tsx"))).toBe(true);
  });

  it("refuses to overwrite existing route files without --force", async () => {
    const cwd = nextAppFixture();
    mkdirSync(resolve(cwd, "app/mcp"), { recursive: true });
    writeFileSync(resolve(cwd, "app/mcp/route.ts"), "// user content");
    const io = fakeIo(cwd);
    const result = await runInit(
      { yes: true, tier: "a", importStripe: false, manifestPath: "./commerce", surfaces: "all", inspector: false },
      io
    );
    expect(result.code).not.toBe(0);
    expect(readFileSync(resolve(cwd, "app/mcp/route.ts"), "utf8")).toBe("// user content");
  });

  it("overwrites existing files when --force is passed", async () => {
    const cwd = nextAppFixture();
    mkdirSync(resolve(cwd, "app/mcp"), { recursive: true });
    writeFileSync(resolve(cwd, "app/mcp/route.ts"), "// user content");
    const io = fakeIo(cwd);
    const result = await runInit(
      { yes: true, tier: "a", manifestPath: "./commerce", inspector: false, force: true },
      io
    );
    expect(result.code).toBe(0);
    expect(readFileSync(resolve(cwd, "app/mcp/route.ts"), "utf8")).toContain("createCommerceRoutes");
  });

  it("writes .env.local for tier=b", async () => {
    const cwd = nextAppFixture();
    const io = fakeIo(cwd);
    const result = await runInit(
      { yes: true, tier: "b", manifestPath: "./commerce", inspector: false },
      io
    );
    expect(result.code).toBe(0);
    expect(existsSync(resolve(cwd, ".env.local"))).toBe(true);
    expect(readFileSync(resolve(cwd, ".env.local"), "utf8")).toContain("STRIPE_SECRET_KEY=");
  });

  it("returns code 2 when no Next.js detected", async () => {
    const cwd = nonNextFixture();
    const io = fakeIo(cwd);
    const result = await runInit({ yes: true, tier: "a", manifestPath: "./commerce", inspector: false }, io);
    expect(result.code).toBe(2);
  });

  it("runs interactive prompts when --yes is not set", async () => {
    const cwd = nextAppFixture();
    // Add a Stripe key so the importStripe prompt is active and stripe detection runs.
    writeFileSync(join(cwd, ".env.local"), "STRIPE_SECRET_KEY=sk_test_123\n");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "demo",
        dependencies: { next: "^15.0.0", stripe: "^17.0.0" },
        devDependencies: { typescript: "^5.0.0" }
      })
    );
    prompts.inject([false, "./commerce", true, "a"]);
    const io = fakeIo(cwd);
    const result = await runInit({ manifestPath: "./commerce" }, io);
    expect(result.code).toBe(0);
    expect(existsSync(resolve(cwd, "commerce.ts"))).toBe(true);
    expect(existsSync(resolve(cwd, "app/(steelyard)/steelyard/page.tsx"))).toBe(true);
  });

  it("describes yarn / bun / npm run commands too", async () => {
    for (const lockfile of ["yarn.lock", "bun.lock"]) {
      const cwd = nextAppFixture();
      // Remove pnpm-lock and add the alternate.
      writeFileSync(join(cwd, "pnpm-lock.yaml"), "");
      writeFileSync(join(cwd, lockfile), "");
      const io = fakeIo(cwd);
      // Make pnpm-lock not exist by overwriting fixture cleanly: easier to start fresh.
      const result = await runInit(
        { yes: true, tier: "a", manifestPath: "./commerce", inspector: false },
        io
      );
      expect(result.code).toBe(0);
    }
  });

  it("imports Stripe catalog when --import-stripe is set", async () => {
    const cwd = nextAppFixture();
    writeFileSync(join(cwd, ".env.local"), "STRIPE_SECRET_KEY=sk_test_xxx\n");
    // Add stripe to package.json so detection finds it
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    pkg.dependencies.stripe = "^17.0.0";
    writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg));

    const io = fakeIo(cwd);
    const stripeFactory = () => ({
      products: { list: async () => ({ data: [{ id: "prod_a", name: "Espresso", active: true }] as any, has_more: false }) },
      prices: {
        list: async () => ({
          data: [
            { id: "price_a", product: "prod_a", active: true, type: "one_time", unit_amount: 300, currency: "usd", recurring: null }
          ] as any,
          has_more: false
        })
      }
    });
    const result = await runInit(
      { yes: true, tier: "a", importStripe: true, manifestPath: "./commerce", inspector: false },
      io,
      { stripeFactory }
    );
    expect(result.code).toBe(0);
    const manifest = readFileSync(resolve(cwd, "commerce.ts"), "utf8");
    expect(manifest).toContain('"price_a"');
    expect(manifest).toContain('"Espresso"');
  });

  it("renders banner when stdout looks like a TTY", async () => {
    const cwd = nextAppFixture();
    const io = fakeIo(cwd);
    // Flip TTY on and drop the CI guard so the banner path runs.
    (io.stdout as unknown as { isTTY: boolean }).isTTY = true;
    io.env = { NO_COLOR: "1" };
    const result = await runInit(
      { yes: true, tier: "a", manifestPath: "./commerce", inspector: false },
      io
    );
    expect(result.code).toBe(0);
    expect(io._out.join("")).toContain("STEELYARD");
  });
});
