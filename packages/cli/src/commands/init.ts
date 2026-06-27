// Copyright (c) Steelyard contributors. MIT License.
//
// `steelyard init` — interactive scaffolder. Detects the project, asks the user
// to confirm a small set of choices, then writes the route files, manifest
// stub, and optional dev inspector page transactionally.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadInspectorPageTemplate } from "@steelyard/next";
import type { CliIO, CommandResult } from "../io.js";
import { renderBanner, shouldShowBanner } from "../init/banner.js";
import { createUi } from "../init/ui.js";
import { detectProject, type ProjectDetection } from "../init/detect.js";
import {
  plannedRouteFiles,
  renderEnvLocalAddition,
  renderManifestStub
} from "../init/templates.js";
import { writePlanTransactional, type WritePlanEntry } from "../init/codegen.js";
import { importFromStripeCatalog, type StripeLike } from "../init/stripe-import.js";

export interface InitOptions {
  yes?: boolean;
  tier?: "a" | "b";
  importStripe?: boolean;
  manifestPath?: string;
  surfaces?: "all" | string;
  inspector?: boolean;
  force?: boolean;
}

export interface InitDeps {
  stripeFactory?: (apiKey: string) => StripeLike;
}

export async function runInit(options: InitOptions, io: CliIO, deps: InitDeps = {}): Promise<CommandResult> {
  const ui = createUi(io);

  const banner = renderBanner({
    tty: Boolean((io.stdout as NodeJS.WriteStream).isTTY),
    noColor: io.env.NO_COLOR === "1"
  });
  if (shouldShowBanner(io.env, (io.stdout as NodeJS.WriteStream).isTTY)) {
    io.stdout.write(`${banner}\n`);
  }

  const project = await detectProject(io.cwd);
  ui.success(`Detected ${describeProject(project)}`);

  if (project.framework !== "next-app" && project.framework !== "next-pages") {
    ui.warn("No Next.js detected in this directory. This release of `init` targets Next.js only.");
    return { code: 2 };
  }

  // Non-interactive (CI / --yes) path
  const answers = options.yes
    ? answersFromDefaults(options)
    : await promptUser(ui, project, options);

  let importedIdentity: Parameters<typeof renderManifestStub>[0]["identity"] | undefined;
  let importedOffers: any[] = [];
  let skipped: { priceId: string; productId: string; reason: string }[] = [];

  if (answers.importStripe && project.stripe.envKey) {
    const apiKey =
      process.env[project.stripe.envKey] ??
      readEnvKey(io.cwd, project.stripe.envFile!, project.stripe.envKey);
    if (!apiKey) {
      ui.warn(`Stripe import requested but ${project.stripe.envKey} not readable; skipping.`);
    } else {
      const factory = deps.stripeFactory ?? (await defaultStripeFactory());
      const stripe = factory(apiKey);
      const spin = ui.spinner("Fetching Stripe catalog…");
      try {
        const result = await importFromStripeCatalog(stripe);
        importedIdentity = result.identity;
        importedOffers = result.offers;
        skipped = result.skipped;
        spin.succeed(`Imported ${result.offers.length} prices · ${result.skipped.length} skipped`);
      } catch (err) {
        spin.fail(`Stripe import failed: ${err instanceof Error ? err.message : err}`);
        return { code: 1 };
      }
    }
  }

  const manifestStub = renderManifestStub({
    identity: importedIdentity ?? {
      name: "My Shop",
      domain: "shop.example",
      currencies: ["USD"]
    },
    offers: importedOffers
  });

  const routes = plannedRouteFiles({ manifestImport: toAliasedImport(answers.manifestPath) });

  const plan: WritePlanEntry[] = [
    ...routes,
    { path: `${stripDotSlash(answers.manifestPath)}.ts`, contents: manifestStub }
  ];

  if (answers.inspector) {
    plan.push({
      path: "app/(steelyard)/steelyard/page.tsx",
      contents: loadInspectorPageTemplate()
    });
  }

  // .env.local is intentionally NOT included in the transactional plan: that
  // writer would overwrite the whole file in --force mode, wiping any of the
  // user's existing env vars. Instead we merge it post-write below.

  ui.line("");
  ui.line("Writing files…");
  const result = await writePlanTransactional(io.cwd, plan, {
    overwrite: options.force ? "replace" : "fail"
  });

  if (!result.ok) {
    ui.error(`Aborted: ${result.error?.message}`);
    ui.line(ui.dim("No files were written. Re-run with --force to overwrite existing files."));
    return { code: 1 };
  }

  for (const path of result.written) {
    ui.success(path);
  }

  if (answers.tier === "b") {
    const merged = mergeEnvLocal(io.cwd, { STRIPE_SECRET_KEY: "sk_test_replace_me" });
    if (merged.added.length > 0) {
      ui.success(`.env.local (added ${merged.added.join(", ")})`);
    } else {
      ui.line(ui.dim(`.env.local already has ${merged.keptExisting.join(", ")}; left untouched.`));
    }
  }

  if (skipped.length > 0) {
    ui.line("");
    ui.line(ui.dim("Skipped during import:"));
    for (const s of skipped) {
      ui.line(`  ${ui.dim("•")} ${s.priceId} — ${s.reason}`);
    }
  }

  ui.line("");
  ui.line("Next:");
  ui.line(`  ${ui.dim("$")} ${describeRunCommand(project, "dev")}`);
  if (answers.inspector) {
    ui.line(`  ${ui.dim("$")} open http://localhost:3000/steelyard`);
  }
  ui.line("");
  if (answers.tier === "a") {
    ui.line(`  Upgrade to agent checkout later:  ${ui.dim("npx")} steelyard enable checkout`);
  }

  return { code: 0 };
}

interface ResolvedAnswers {
  tier: "a" | "b";
  manifestPath: string;
  inspector: boolean;
  importStripe: boolean;
}

function answersFromDefaults(opts: InitOptions): ResolvedAnswers {
  return {
    tier: opts.tier ?? "a",
    manifestPath: opts.manifestPath ?? "./commerce",
    inspector: opts.inspector ?? true,
    importStripe: opts.importStripe ?? false
  };
}

async function promptUser(
  ui: ReturnType<typeof createUi>,
  project: ProjectDetection,
  opts: InitOptions
): Promise<ResolvedAnswers> {
  const answers = await ui.prompt([
    {
      type: project.stripe.installed ? "confirm" : null,
      name: "importStripe",
      message: "Import your Stripe catalog?",
      initial: true
    },
    {
      type: "text",
      name: "manifestPath",
      message: "Manifest file path?",
      initial: opts.manifestPath ?? "./commerce"
    },
    {
      type: "confirm",
      name: "inspector",
      message: "Install dev inspector at /steelyard?",
      initial: true
    },
    {
      type: "select",
      name: "tier",
      message: "Tier?",
      choices: [
        { title: "Discovery-only (tier A — no money moves)", value: "a" },
        { title: "Agent checkout (tier B — uses your Stripe keys)", value: "b" }
      ],
      initial: 0
    }
  ] as any);
  return {
    tier: (answers.tier as "a" | "b") ?? "a",
    manifestPath: (answers.manifestPath as string) ?? "./commerce",
    inspector: answers.inspector !== false,
    importStripe: Boolean(answers.importStripe)
  };
}

function describeProject(project: ProjectDetection): string {
  const fw = project.framework === "next-app" ? "Next.js (App Router)" :
             project.framework === "next-pages" ? "Next.js (Pages Router)" :
             "no Next.js";
  return `${fw} · ${project.language.toUpperCase()} · ${project.packageManager}` +
    (project.stripe.installed ? ` · Stripe${project.stripe.testMode ? " (test mode)" : ""}` : "");
}

function describeRunCommand(project: ProjectDetection, script: string): string {
  switch (project.packageManager) {
    case "pnpm": return `pnpm ${script}`;
    case "yarn": return `yarn ${script}`;
    case "bun": return `bun ${script}`;
    default: return `npm run ${script}`;
  }
}

function stripDotSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

// Convert a filesystem-style path (e.g. "./commerce", "./src/commerce") into
// a Next.js-aliased import string ("@/commerce", "@/src/commerce"). Generated
// route files live deep under `app/`, so a relative "./commerce" import would
// resolve relative to each route file rather than to the project root — which
// is what users actually want. Pass through paths that don't start with "./".
function toAliasedImport(p: string): string {
  if (p.startsWith("./")) return `@/${p.slice(2)}`;
  return p;
}

function readEnvKey(cwd: string, envFile: string, key: string): string | undefined {
  try {
    const contents = readFileSync(resolve(cwd, envFile), "utf8");
    const m = contents.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

async function defaultStripeFactory(): Promise<(apiKey: string) => StripeLike> {
  const { default: Stripe } = await import("stripe");
  return (apiKey: string) => new Stripe(apiKey) as unknown as StripeLike;
}

// Merge missing keys into .env.local without clobbering existing content.
// Used for tier-B init: we add STRIPE_SECRET_KEY=sk_test_replace_me only when
// the user doesn't already have that key set. Never overwrites — that would
// destroy DB urls / API keys / etc. the user already had in the file.
function mergeEnvLocal(
  cwd: string,
  defaults: Record<string, string>
): { added: string[]; keptExisting: string[] } {
  const path = resolve(cwd, ".env.local");
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    /* file doesn't exist; we'll create it */
  }

  const added: string[] = [];
  const keptExisting: string[] = [];
  let next = existing;
  if (next && !next.endsWith("\n")) next += "\n";

  for (const [key, value] of Object.entries(defaults)) {
    if (new RegExp(`^${key}=`, "m").test(existing)) {
      keptExisting.push(key);
      continue;
    }
    if (added.length === 0 && next.length > 0) {
      next += "\n# Added by `steelyard init` — required for tier-B agent checkout.\n";
    } else if (added.length === 0) {
      next += "# Added by `steelyard init` — required for tier-B agent checkout.\n";
    }
    next += `${key}=${value}\n`;
    added.push(key);
  }

  if (added.length > 0) {
    writeFileSync(path, next, "utf8");
  }
  return { added, keptExisting };
}
