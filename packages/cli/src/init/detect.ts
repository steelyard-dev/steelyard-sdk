// Copyright (c) Steelyard contributors. MIT License.
//
// Project detection. Pure async functions over a cwd path. Each detector is
// independent so future frameworks (Remix, SvelteKit) can plug in without
// touching the others.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export type Framework = "next-app" | "next-pages" | "generic";
export type Language = "ts" | "js";
export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

export interface StripeDetection {
  installed: boolean;
  envFile?: string;
  envKey?: string;
  testMode?: boolean;
}

export interface ProjectDetection {
  cwd: string;
  framework: Framework;
  language: Language;
  packageManager: PackageManager;
  stripe: StripeDetection;
}

export async function detectProject(cwd: string): Promise<ProjectDetection> {
  const pkg = await readJsonOrNull(resolve(cwd, "package.json"));
  return {
    cwd,
    framework: await detectFramework(cwd, pkg),
    language: (await pathExists(resolve(cwd, "tsconfig.json"))) ? "ts" : "js",
    packageManager: await detectPackageManager(cwd),
    stripe: await detectStripe(cwd, pkg)
  };
}

async function detectFramework(cwd: string, pkg: Record<string, any> | null): Promise<Framework> {
  const hasNext = Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  if (!hasNext) return "generic";
  if (await pathExists(resolve(cwd, "app"))) return "next-app";
  if (await pathExists(resolve(cwd, "pages"))) return "next-pages";
  return "next-app";
}

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await pathExists(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(resolve(cwd, "yarn.lock"))) return "yarn";
  if (await pathExists(resolve(cwd, "bun.lock"))) return "bun";
  return "npm";
}

async function detectStripe(cwd: string, pkg: Record<string, any> | null): Promise<StripeDetection> {
  const installed = Boolean(pkg?.dependencies?.stripe || pkg?.devDependencies?.stripe);
  for (const envFile of [".env.local", ".env", ".env.development.local"]) {
    const path = resolve(cwd, envFile);
    if (!(await pathExists(path))) continue;
    const contents = await readFile(path, "utf8").catch(() => "");
    const match = contents.match(/^STRIPE_SECRET_KEY=(.+)$/m);
    if (match?.[1]) {
      const key = match[1].trim().replace(/^["']|["']$/g, "");
      return {
        installed: true,
        envFile,
        envKey: "STRIPE_SECRET_KEY",
        testMode: key.startsWith("sk_test_")
      };
    }
  }
  return { installed };
}

async function readJsonOrNull(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
