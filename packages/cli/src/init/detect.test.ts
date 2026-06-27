import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { detectProject } from "./detect.js";

const FIX = (name: string) => resolve(import.meta.dirname, "..", "..", "test", "fixtures", name);

describe("detectProject", () => {
  it("detects Next App Router + TS + pnpm + Stripe", async () => {
    const r = await detectProject(FIX("next-app-ts"));
    expect(r.framework).toBe("next-app");
    expect(r.language).toBe("ts");
    expect(r.packageManager).toBe("pnpm");
    expect(r.stripe.installed).toBe(true);
    expect(r.stripe.envKey).toBe("STRIPE_SECRET_KEY");
    expect(r.stripe.testMode).toBe(true);
  });

  it("detects Next Pages Router + JS + npm", async () => {
    const r = await detectProject(FIX("next-pages-js"));
    expect(r.framework).toBe("next-pages");
    expect(r.language).toBe("js");
    expect(r.packageManager).toBe("npm");
    expect(r.stripe.installed).toBe(false);
  });

  it("falls back to generic for non-Next projects", async () => {
    const r = await detectProject(FIX("plain-node"));
    expect(r.framework).toBe("generic");
  });
});
