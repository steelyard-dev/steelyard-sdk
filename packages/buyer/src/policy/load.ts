import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Decision, PurchaseIntent, Rule, SpendLimits } from "@steelyard/core";
import type { PolicySpendContext } from "@steelyard/core/policy-yaml";
import type { BuyerVault } from "../vault/index.js";
import { evaluatePolicy } from "./evaluate.js";
import { parsePolicyYaml, type ParsedPolicyDocument } from "./schema.js";

export interface BuyerPolicyLoadOptions {
  paths?: string[];
  allowMissingPolicy?: boolean;
}

export class BuyerPolicy {
  readonly rules: ReadonlyArray<Rule>;
  readonly limits: SpendLimits;
  readonly isPermissive: boolean;
  #documents: ParsedPolicyDocument[];

  private constructor(documents: ParsedPolicyDocument[], isPermissive: boolean) {
    this.#documents = documents;
    this.rules = documents.flatMap((document) => document.rules);
    this.limits = mergeLimits(documents.map((document) => document.limits));
    this.isPermissive = isPermissive;
  }

  static async load(opts: BuyerPolicyLoadOptions = {}): Promise<BuyerPolicy> {
    const paths = opts.paths?.map((path) => resolve(path)) ?? [projectPolicyPath(), globalPolicyPath()];
    const documents = await readPolicyDocuments(paths);
    if (!documents.length) {
      if (opts.allowMissingPolicy) {
        warnPermissiveOnce(paths);
        return new BuyerPolicy([permissiveDocument()], true);
      }
      throw new Error(`no policy file found at ${paths.join(", ")}`);
    }
    return new BuyerPolicy(documents, false);
  }

  static async loadGlobal(opts: Omit<BuyerPolicyLoadOptions, "paths"> = {}): Promise<BuyerPolicy> {
    return BuyerPolicy.load({ ...opts, paths: [globalPolicyPath()] });
  }

  static async loadProject(opts: Omit<BuyerPolicyLoadOptions, "paths"> = {}): Promise<BuyerPolicy> {
    return BuyerPolicy.load({ ...opts, paths: [projectPolicyPath()] });
  }

  async evaluate(intent: PurchaseIntent, ctx: { vault?: BuyerVault } = {}): Promise<Decision> {
    return evaluatePolicy(this.#documents, intent, adaptSpendContext(ctx.vault));
  }
}

let permissiveWarningPrinted = false;

async function readPolicyDocuments(paths: string[]): Promise<ParsedPolicyDocument[]> {
  const documents: ParsedPolicyDocument[] = [];
  for (const path of paths) {
    if (!(await exists(path))) continue;
    documents.push(parsePolicyYaml(await readFile(path, "utf8"), path));
  }
  return documents;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function permissiveDocument(): ParsedPolicyDocument {
  return {
    path: "<no-policy-permissive>",
    default: "deny",
    rules: [{ name: "no-policy-permissive", effect: "can", action: "buy" }],
    limits: {}
  };
}

function warnPermissiveOnce(paths: string[]): void {
  if (permissiveWarningPrinted) return;
  process.stderr.write(
    "⚠ steelyard/buyer/policy: no policy file found and allowMissingPolicy=true\n" +
      "  — running in permissive mode (all purchases allowed).\n" +
      `  searched: ${paths.join(", ")}\n`
  );
  permissiveWarningPrinted = true;
}

function projectPolicyPath(): string {
  return resolve(".steelyard", "policy.yml");
}

function globalPolicyPath(): string {
  return join(homedir(), ".steelyard", "policy.yml");
}

function mergeLimits(limits: SpendLimits[]): SpendLimits {
  const merged: SpendLimits = {};
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const entries = limits.flatMap((limit) => Object.entries(limit[window] ?? {}));
    if (!entries.length) continue;
    merged[window] = {};
    for (const [currency, amount] of entries) {
      merged[window]![currency] = Math.min(merged[window]![currency] ?? Number.POSITIVE_INFINITY, amount);
    }
  }
  return merged;
}

function adaptSpendContext(vault?: BuyerVault): { vault?: PolicySpendContext } {
  if (!vault) return {};
  return {
    vault: {
      spendInWindow: async (window, currency) => vault.spendInWindow(window, currency)
    }
  };
}

export function _resetPermissiveWarningForTests(): void {
  permissiveWarningPrinted = false;
}
