// Copyright (c) Steelyard contributors. MIT License.
//
// `steelyard enable checkout` — tier A → B upgrade. Verifies a Stripe key,
// checks whether the account is enrolled in Stripe's agentic commerce
// program, sanity-checks that `steelyard init` has already been run, then
// merges STEELYARD_TIER=b into .env.local (never clobbering existing vars).
//
// Note: this command lays the foundation for tier B (key + tier flag +
// preflight checks). Generating the merchant checkout HTTP endpoint that
// actually accepts agent purchases is tracked as a follow-up — see TODO.md.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CliIO, CommandResult } from "../io.js";
import { createUi, type Ui } from "../init/ui.js";

export interface EnableCheckoutOptions {
  yes?: boolean;
  /** Allow live-mode Stripe keys without an extra confirmation. */
  allowLive?: boolean;
}

interface StripeAccount {
  id: string;
  livemode: boolean;
  // Stripe exposes a `capabilities` map on accounts. The exact key for the
  // Agentic Commerce / Delegated Authorization product depends on a beta
  // enrollment; today we surface whatever's there and let the user verify.
  capabilities?: Record<string, string | undefined>;
}

export interface EnableCheckoutDeps {
  stripeFactory?: (apiKey: string) => {
    accounts: { retrieve: () => Promise<StripeAccount> };
  };
}

// Capability keys we recognize as enabling agentic / delegated payments.
// The Stripe API has used several names while the product was in beta; check
// all of them rather than guessing. Anything that says "active" passes.
const AGENTIC_CAPABILITY_KEYS = [
  "agentic_commerce_payments",
  "delegated_authorization_payments",
  "agentic_payments",
  "shared_payment_token_payments"
] as const;

export async function runEnableCheckout(
  opts: EnableCheckoutOptions,
  io: CliIO,
  deps: EnableCheckoutDeps = {}
): Promise<CommandResult> {
  const ui = createUi(io);
  ui.warn("This will start accepting agent purchases against your Stripe account.");

  const preflight = preflightInit(io.cwd, ui);
  if (preflight.code !== 0) return preflight;

  const apiKey = readStripeKey(io);
  if (!apiKey) {
    ui.error("No Stripe key found. Set STRIPE_SECRET_KEY in .env.local first.");
    return { code: 2 };
  }

  const factory = deps.stripeFactory ?? (await defaultStripeFactory());
  const stripe = factory(apiKey);
  const spin = ui.spinner("Verifying key…");
  let acct: StripeAccount;
  try {
    acct = await stripe.accounts.retrieve();
    spin.succeed(`Connected to ${acct.id} (${acct.livemode ? "live" : "test"} mode)`);
  } catch (err) {
    spin.fail(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { code: 1 };
  }

  // Live-mode guard. Tier B accepts real money via agents, so don't let a
  // live key flow in by accident from a dev .env.local copy.
  if (acct.livemode && !opts.allowLive) {
    ui.error(
      "Live-mode Stripe key detected. Re-run with --allow-live to confirm you " +
        "want to enable agent purchases against your live account."
    );
    return { code: 3 };
  }

  // Agentic-payments capability check. Not all Stripe accounts are enrolled
  // in the agentic commerce program; surface the status so users aren't
  // surprised when their agent purchases fail server-side.
  const capabilityStatus = checkAgenticCapability(acct.capabilities);
  if (capabilityStatus.kind === "active") {
    ui.success(`Agentic payments capability: ${capabilityStatus.key} (active)`);
  } else if (capabilityStatus.kind === "pending") {
    ui.warn(
      `Agentic payments capability "${capabilityStatus.key}" is ${capabilityStatus.state}. ` +
        "Agent purchases will fail until Stripe approves it."
    );
  } else {
    ui.warn(
      "No agentic-payments capability detected on this Stripe account. " +
        "Agent purchases require enrollment in Stripe's agentic commerce program — " +
        "visit https://dashboard.stripe.com/settings to request access."
    );
  }

  // Merge STEELYARD_TIER=b into .env.local (preserving any existing keys).
  const envPath = resolve(io.cwd, ".env.local");
  const existing = safeRead(envPath);
  if (/^STEELYARD_TIER=/m.test(existing)) {
    writeFileSync(envPath, existing.replace(/^STEELYARD_TIER=.*$/m, "STEELYARD_TIER=b"));
  } else {
    const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
    appendFileSync(envPath, `${sep}STEELYARD_TIER=b\n`);
  }
  ui.success("Set STEELYARD_TIER=b in .env.local");

  ui.line("");
  ui.line("Next:");
  ui.line(`  curl localhost:3000/.well-known/ucp`);
  return { code: 0 };
}

interface CapabilityStatus {
  kind: "active" | "pending" | "missing";
  key?: string;
  state?: string;
}

function checkAgenticCapability(
  capabilities: Record<string, string | undefined> | undefined
): CapabilityStatus {
  if (!capabilities) return { kind: "missing" };
  for (const key of AGENTIC_CAPABILITY_KEYS) {
    const state = capabilities[key];
    if (!state) continue;
    if (state === "active") return { kind: "active", key };
    return { kind: "pending", key, state };
  }
  return { kind: "missing" };
}

interface PreflightOk {
  code: 0;
}
interface PreflightFail {
  code: number;
}

function preflightInit(cwd: string, ui: Ui): PreflightOk | PreflightFail {
  // Look for the artifacts `steelyard init` creates. Don't require ALL of them
  // (a user may have moved/renamed commerce.ts), but require at least one
  // route + the manifest so we know this is a Steelyard-initialized project.
  const hasManifest =
    existsSync(resolve(cwd, "commerce.ts")) || existsSync(resolve(cwd, "commerce.js"));
  const hasRoutes = existsSync(resolve(cwd, "app/.well-known/commerce.json/route.ts"));
  if (!hasManifest && !hasRoutes) {
    ui.error(
      "This doesn't look like a Steelyard project (no commerce.ts and no app/.well-known/commerce.json route)."
    );
    ui.line(ui.dim("Run `steelyard init` first."));
    return { code: 4 };
  }
  return { code: 0 };
}

function readStripeKey(io: CliIO): string | undefined {
  if (io.env.STRIPE_SECRET_KEY) return io.env.STRIPE_SECRET_KEY;
  for (const f of [".env.local", ".env"]) {
    const contents = safeRead(resolve(io.cwd, f));
    const m = contents.match(/^STRIPE_SECRET_KEY=(.+)$/m);
    const value = m?.[1];
    if (value) return value.trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function defaultStripeFactory(): Promise<(apiKey: string) => any> {
  const { default: Stripe } = await import("stripe");
  return (apiKey: string) => new Stripe(apiKey) as any;
}
