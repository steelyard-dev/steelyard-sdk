// Copyright (c) Steelyard contributors. MIT License.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Decision, PurchaseIntent, Rule, SpendLimits } from "@steelyard-dev/core";
import {
  evaluatePolicy,
  parsePolicyYaml,
  type ParsedPolicyDocument,
  type PolicySpendContext
} from "@steelyard-dev/core/policy-yaml";

export interface MerchantPolicyLoadOptions {
  path?: string;
}

export interface MerchantPolicyEvaluateOptions {
  context?: unknown;
  vault?: PolicySpendContext;
}

export class MerchantPolicyMissing extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`merchant policy file missing: ${path}`);
    this.name = "MerchantPolicyMissing";
    this.path = path;
  }
}

interface CachedPolicy {
  mtimeMs: number;
  document: ParsedPolicyDocument;
}

export class MerchantPolicy {
  readonly path: string;
  #cached: CachedPolicy | undefined;
  #hotReload: boolean;

  private constructor(path: string, cached: CachedPolicy | undefined, hotReload: boolean) {
    this.path = path;
    this.#cached = cached;
    this.#hotReload = hotReload;
  }

  static async load(opts: MerchantPolicyLoadOptions = {}): Promise<MerchantPolicy> {
    const path = resolve(opts.path ?? defaultPolicyPath());
    const cached = await readCurrentPolicy(path, undefined);
    return new MerchantPolicy(path, cached, false);
  }

  static fromPath(path: string): MerchantPolicy {
    return new MerchantPolicy(resolve(path), undefined, true);
  }

  get rules(): readonly Rule[] {
    return this.#cached?.document.rules ?? [];
  }

  get limits(): SpendLimits {
    return this.#cached?.document.limits ?? {};
  }

  async evaluate(intent: PurchaseIntent, opts: MerchantPolicyEvaluateOptions = {}): Promise<Decision> {
    if (this.#hotReload) {
      this.#cached = await readCurrentPolicy(this.path, this.#cached);
    }
    const cached = this.#cached;
    /* c8 ignore next -- private constructor guarantees non-hot policies start cached. */
    if (!cached) throw new MerchantPolicyMissing(this.path);
    return evaluatePolicy([cached.document], intent, { vault: opts.vault });
  }
}

async function readCurrentPolicy(path: string, cached: CachedPolicy | undefined): Promise<CachedPolicy> {
  const before = await statPolicy(path);
  if (cached && cached.mtimeMs === before.mtimeMs) return cached;

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readFile(path, "utf8");
    const after = await statPolicy(path);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) continue;
    try {
      return {
        mtimeMs: after.mtimeMs,
        document: parsePolicyYaml(raw, path)
      };
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  }

  /* c8 ignore next -- this only runs when a policy file changes during every retry window. */
  return await readCurrentPolicy(path, cached);
}

async function statPolicy(path: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MerchantPolicyMissing(path);
    /* c8 ignore next -- stat errors other than ENOENT are filesystem/platform failures. */
    throw error;
  }
}

function defaultPolicyPath(): string {
  return join(homedir(), ".steelyard", "merchant-policy.yml");
}
