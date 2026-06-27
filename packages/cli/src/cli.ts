// Copyright (c) Steelyard contributors. MIT License.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cac from "cac";
import { doctorCommand } from "./commands/doctor.js";
import { runEnableCheckout } from "./commands/enable-checkout.js";
import { runInit } from "./commands/init.js";
import { manifestCommand } from "./commands/manifest.js";
import { validateCommand } from "./commands/validate.js";
import { defaultIO, type CliIO, type CommandResult, writeLine } from "./io.js";

const STDIN_SENTINEL = "__STEELYARD_STDIN_SOURCE__";

export async function runCli(argv = process.argv.slice(2), io: CliIO = defaultIO()): Promise<number> {
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

  cli
    .command("init", "Scaffold Steelyard surfaces into a Next.js app")
    .option("--yes", "Accept all defaults (non-interactive)")
    .option("--tier <tier>", "a (discovery) or b (checkout)", { default: "a" })
    .option("--manifest <path>", "Manifest file path", { default: "./commerce" })
    .option("--import-stripe", "Import the Stripe catalog (skipped if absent)")
    .option("--no-inspector", "Skip dev inspector page")
    .option("--force", "Overwrite existing files")
    .option("--skip-install", "Skip running the package manager after codegen")
    .action(async (options: Record<string, unknown>) => {
      result = await runInit(
        {
          yes: Boolean(options.yes),
          tier: (options.tier as "a" | "b") ?? "a",
          manifestPath: (options.manifest as string) ?? "./commerce",
          importStripe: Boolean(options.importStripe),
          inspector: options.inspector !== false,
          force: Boolean(options.force),
          skipInstall: Boolean(options.skipInstall)
        },
        io
      );
    });

  cli
    .command("enable <feature>", "Enable a Steelyard feature in this project")
    .option("--yes", "Accept all defaults")
    .action(async (feature: string, options: Record<string, unknown>) => {
      if (feature === "checkout") {
        result = await runEnableCheckout({ yes: Boolean(options.yes) }, io);
      } else {
        writeLine(io.stderr, `unknown feature: ${feature}`);
        result = { code: 4 };
      }
    });

  cli.help();

  try {
    cli.parse(["node", "steelyard", ...argv.map((arg) => (arg === "-" ? STDIN_SENTINEL : arg))], { run: false });
    await cli.runMatchedCommand();
    if (!result) {
      writeLine(io.stderr, "usage: steelyard <validate|manifest|doctor|init|enable> ...");
      return 4;
    }
    return result.code;
  } catch (error) {
    writeLine(io.stderr, error instanceof Error ? error.message : String(error));
    return 4;
  }
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
