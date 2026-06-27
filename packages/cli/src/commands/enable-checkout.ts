// Copyright (c) Steelyard contributors. MIT License.
//
// `steelyard enable checkout` — tier A → B upgrade. Verifies a Stripe key,
// flips STEELYARD_TIER=b in .env.local. (Manifest augmentation with stripe.priceId
// will be added when the Stripe import flow runs; in v0.10 this command focuses
// on the safe parts: key verification and tier flip.)

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CliIO, CommandResult } from "../io.js";
import { createUi } from "../init/ui.js";

export interface EnableCheckoutOptions {
  yes?: boolean;
}

export interface EnableCheckoutDeps {
  stripeFactory?: (apiKey: string) => {
    accounts: { retrieve: () => Promise<{ id: string; livemode: boolean }> };
  };
}

export async function runEnableCheckout(
  opts: EnableCheckoutOptions,
  io: CliIO,
  deps: EnableCheckoutDeps = {}
): Promise<CommandResult> {
  void opts;
  const ui = createUi(io);
  ui.warn("This will start accepting agent purchases against your Stripe account.");

  const apiKey = readStripeKey(io);
  if (!apiKey) {
    ui.error("No Stripe key found. Set STRIPE_SECRET_KEY in .env.local first.");
    return { code: 2 };
  }

  const factory = deps.stripeFactory ?? (await defaultStripeFactory());
  const stripe = factory(apiKey);
  const spin = ui.spinner("Verifying key…");
  let acct: { id: string; livemode: boolean };
  try {
    acct = await stripe.accounts.retrieve();
    spin.succeed(`Connected to ${acct.id} (${acct.livemode ? "live" : "test"} mode)`);
  } catch (err) {
    spin.fail(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { code: 1 };
  }

  // Set tier in .env.local
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

function readStripeKey(io: CliIO): string | undefined {
  if (io.env.STRIPE_SECRET_KEY) return io.env.STRIPE_SECRET_KEY;
  for (const f of [".env.local", ".env"]) {
    const contents = safeRead(resolve(io.cwd, f));
    const m = contents.match(/^STRIPE_SECRET_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
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
