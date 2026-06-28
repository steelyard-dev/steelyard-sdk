// Copyright (c) Steelyard contributors. MIT License.
import { resolve } from "node:path";
import { loadPolicyFromFile } from "@steelyard/policy";
import type { CliIO, CommandResult } from "../../io.js";
import { writeLine } from "../../io.js";

export interface PolicyLintOptions {
  json?: boolean;
}

export async function policyLintCommand(path: string, opts: PolicyLintOptions, io: CliIO): Promise<CommandResult> {
  const filePath = resolve(io.cwd, path);
  try {
    const { warnings } = loadPolicyFromFile(filePath);
    if (opts.json) {
      writeLine(io.stdout, JSON.stringify({ ok: true, warnings }));
      return { code: 0 };
    }
    if (warnings.length === 0) {
      writeLine(io.stdout, `ok: ${path} (no warnings)`);
      return { code: 0 };
    }
    for (const warning of warnings) {
      writeLine(io.stderr, `warning [${warning.code}]${warning.rule ? ` (rule: ${warning.rule})` : ""}: ${warning.message}`);
    }
    return { code: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) writeLine(io.stdout, JSON.stringify({ ok: false, error: message }));
    else writeLine(io.stderr, `error: ${message}`);
    return { code: 1 };
  }
}
