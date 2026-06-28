// Copyright (c) Steelyard contributors. MIT License.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cac from "cac";
import { doctorCommand } from "./commands/doctor.js";
import { manifestCommand } from "./commands/manifest.js";
import { policyAuditVerifyCommand } from "./commands/policy/audit-verify.js";
import { policyLintCommand } from "./commands/policy/lint.js";
import { policyRunCommand } from "./commands/policy/run.js";
import { validateCommand } from "./commands/validate.js";
import { defaultIO, type CliIO, type CommandResult, writeLine } from "./io.js";

const STDIN_SENTINEL = "__STEELYARD_STDIN_SOURCE__";

export async function runCli(argv = process.argv.slice(2), io: CliIO = defaultIO()): Promise<number> {
  const policyResult = await runPolicyCommand(argv, io);
  if (policyResult) return policyResult.code;

  let result: CommandResult | undefined;
  const cli = cac("steelyard");

  cli
    .command("validate <source>", "Validate a Steelyard commerce manifest")
    .option("--json", "Emit machine-readable JSON")
    .option("--strict", "Reject unknown root-level fields")
    .option("--module", "Load source as a JavaScript module")
    .option("--export <name>", "Named export for --module")
    .option("--allow-private-network", "Allow fetching private-network URLs")
    .option("--interactive", "Allow reading stdin from a TTY")
    .action(async (source: string, options: Record<string, unknown>) => {
      result = await validateCommand(normalizeSourceArg(source), normalizeSourceOptions(options), io);
    });

  cli
    .command("manifest <source>", "Generate a v0.4 commerce manifest from a v0.3 manifest")
    .option("--json", "Wrap output as { doc, warnings }")
    .option("--pretty", "Pretty-print JSON")
    .option("--module", "Load source as a JavaScript module")
    .option("--export <name>", "Named export for --module")
    .option("--peer <name=url>", "Peer endpoint URL")
    .option("--protocol-version <name=value>", "Peer protocol version")
    .option("--generated-at <iso>", "Fixed generated_at timestamp")
    .option("--allow-private-network", "Allow fetching private-network URLs")
    .option("--interactive", "Allow reading stdin from a TTY")
    .action(async (source: string, options: Record<string, unknown>) => {
      result = await manifestCommand(normalizeSourceArg(source), normalizeManifestOptions(options), io);
    });

  cli
    .command("doctor", "Check local Steelyard read-side setup")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: Record<string, unknown>) => {
      result = await doctorCommand({ json: Boolean(options.json) }, io);
    });

  cli.help();

  try {
    cli.parse(["node", "steelyard", ...argv.map((arg) => (arg === "-" ? STDIN_SENTINEL : arg))], { run: false });
    await cli.runMatchedCommand();
    if (!result) {
      writeLine(io.stderr, "usage: steelyard <validate|manifest|doctor|policy> ...");
      return 4;
    }
    return result.code;
  } catch (error) {
    writeLine(io.stderr, error instanceof Error ? error.message : String(error));
    return 4;
  }
}

async function runPolicyCommand(argv: string[], io: CliIO): Promise<CommandResult | undefined> {
  if (argv[0] !== "policy") return undefined;
  if (argv[1] === "audit" && argv[2] === "verify") return await runPolicyAuditVerifyCommand(argv.slice(3), io);
  if (argv[1] === "run") return await runPolicyRunCommand(argv.slice(2), io);
  if (argv[1] !== "lint") {
    writeLine(io.stderr, "usage: steelyard policy <lint|run|audit> ...");
    return { code: 4 };
  }

  let json = false;
  let path: string | undefined;
  for (const arg of argv.slice(2)) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      writeLine(io.stderr, `unknown option: ${arg}`);
      return { code: 4 };
    } else if (!path) {
      path = arg;
    } else {
      writeLine(io.stderr, "usage: steelyard policy lint <path> [--json]");
      return { code: 4 };
    }
  }

  if (!path) {
    writeLine(io.stderr, "usage: steelyard policy lint <path> [--json]");
    return { code: 4 };
  }
  return await policyLintCommand(path, { json }, io);
}

async function runPolicyRunCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  let policy: string | undefined;
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--policy") {
      policy = argv[++i];
    } else if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else {
      writeLine(io.stderr, "usage: steelyard policy run [--policy <path>] [--data-dir <path>]");
      return { code: 4 };
    }
    if (!argv[i]) {
      writeLine(io.stderr, "usage: steelyard policy run [--policy <path>] [--data-dir <path>]");
      return { code: 4 };
    }
  }
  return await policyRunCommand({ policy, dataDir }, io);
}

async function runPolicyAuditVerifyCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  const dataDir = argv[0];
  if (argv.length !== 1 || !dataDir || dataDir.startsWith("-")) {
    writeLine(io.stderr, "usage: steelyard policy audit verify <data-dir>");
    return { code: 4 };
  }
  return await policyAuditVerifyCommand(dataDir, io);
}

function normalizeSourceArg(source: string): string {
  return source === STDIN_SENTINEL ? "-" : source;
}

function normalizeSourceOptions(options: Record<string, unknown>) {
  return {
    json: Boolean(options.json),
    strict: Boolean(options.strict),
    module: Boolean(options.module),
    exportName: typeof options.export === "string" ? options.export : undefined,
    allowPrivateNetwork: Boolean(options.allowPrivateNetwork),
    interactive: Boolean(options.interactive)
  };
}

function normalizeManifestOptions(options: Record<string, unknown>) {
  return {
    ...normalizeSourceOptions(options),
    pretty: Boolean(options.pretty),
    peer: flagValues(options.peer),
    protocolVersion: flagValues(options.protocolVersion),
    generatedAt: typeof options.generatedAt === "string" ? options.generatedAt : undefined
  };
}

function flagValues(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value : undefined;
}

const argvPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === argvPath) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}

export { validateCommand } from "./commands/validate.js";
export { manifestCommand } from "./commands/manifest.js";
export { doctorCommand } from "./commands/doctor.js";
export { policyAuditVerifyCommand } from "./commands/policy/audit-verify.js";
export { policyLintCommand } from "./commands/policy/lint.js";
export { policyRunCommand } from "./commands/policy/run.js";
