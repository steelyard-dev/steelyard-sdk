// Copyright (c) Steelyard contributors. MIT License.
//
// `steelyard init` — interactive scaffolder. Detects the project, asks the user
// to confirm a small set of choices, then writes the route files, manifest
// stub, and optional dev inspector page transactionally.

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

export interface InitOptions {
  yes?: boolean;
  tier?: "a" | "b";
  importStripe?: boolean;
  manifestPath?: string;
  surfaces?: "all" | string;
  inspector?: boolean;
  force?: boolean;
}

export async function runInit(options: InitOptions, io: CliIO): Promise<CommandResult> {
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

  // Manifest seed: empty by default. (Stripe import is wired in Task 13.)
  const manifestStub = renderManifestStub({
    identity: {
      name: "My Shop",
      domain: "shop.example",
      currencies: ["USD"]
    },
    offers: []
  });

  const routes = plannedRouteFiles({ manifestImport: answers.manifestPath });

  const plan: WritePlanEntry[] = [
    ...routes,
    { path: `${stripDotSlash(answers.manifestPath)}.ts`, contents: manifestStub }
  ];

  if (answers.inspector) {
    plan.push({
      path: "app/(steelyard)/__steelyard/page.tsx",
      contents: loadInspectorPageTemplate()
    });
  }

  if (answers.tier === "b") {
    plan.push({
      path: ".env.local",
      contents: renderEnvLocalAddition("b").trimStart()
    });
  }

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

  ui.line("");
  ui.line("Next:");
  ui.line(`  ${ui.dim("$")} ${describeRunCommand(project, "dev")}`);
  if (answers.inspector) {
    ui.line(`  ${ui.dim("$")} open http://localhost:3000/__steelyard`);
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
      message: "Install dev inspector at /__steelyard?",
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
