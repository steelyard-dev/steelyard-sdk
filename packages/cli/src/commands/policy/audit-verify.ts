// Copyright (c) Steelyard contributors. MIT License.
import { join, resolve } from "node:path";
import { verifyChain } from "@steelyard-dev/policy";
import type { CliIO, CommandResult } from "../../io.js";
import { writeLine } from "../../io.js";

export async function policyAuditVerifyCommand(dataDir: string, io: CliIO): Promise<CommandResult> {
  const resolvedDataDir = resolve(io.cwd, dataDir);
  const auditDir = join(resolvedDataDir, "audit");
  const result = await verifyChain(auditDir);
  if (result.ok) {
    writeLine(io.stdout, `ok: hash chain intact (${auditDir})`);
    return { code: 0 };
  }
  for (const chainBreak of result.breaks) {
    writeLine(io.stderr, `break: ${chainBreak.file}:${chainBreak.line}:${chainBreak.offset} ${chainBreak.reason}`);
  }
  return { code: 1 };
}
