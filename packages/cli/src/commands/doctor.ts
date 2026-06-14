// Copyright (c) Steelyard contributors. MIT License.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { CommandResult, CliIO } from "../io.js";
import { writeLine } from "../io.js";

export interface DoctorOptions {
  json?: boolean;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  value?: string;
  message?: string;
}

const httpSchemas = [
  "capabilities_response.schema.json",
  "error.schema.json",
  "index_response.schema.json",
  "offer.schema.json",
  "policies_response.schema.json",
  "policy.schema.json",
  "products_response.schema.json"
];

export async function doctorCommand(opts: DoctorOptions, io: CliIO): Promise<CommandResult> {
  const checks = runDoctorChecks();
  const ok = checks.every((check) => check.ok);

  if (opts.json) {
    writeLine(io.stdout, JSON.stringify({ ok, checks }));
  } else {
    for (const check of checks) {
      writeLine(io.stdout, `${check.ok ? "PASS" : "FAIL"} ${check.name}${check.message ? ` - ${check.message}` : ""}`);
    }
  }

  return { code: ok ? 0 : 1 };
}

export function runDoctorChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "node_version",
    ok: Number(process.versions.node.split(".")[0]) >= 20,
    value: process.versions.node
  });

  const specRoot = resolveCoreDistSpec();
  const commerceSchema = resolve(specRoot, "commerce-manifest", "0.1", "commerce-manifest.schema.json");
  const httpRoot = resolve(specRoot, "http", "0.1");
  checks.push({
    name: "commerce_schema",
    ok: existsSync(commerceSchema),
    value: commerceSchema,
    message: existsSync(commerceSchema) ? undefined : "commerce manifest schema not found"
  });
  checks.push({
    name: "http_schemas",
    ok: existsSync(httpRoot) && httpSchemas.every((schema) => existsSync(resolve(httpRoot, schema))),
    value: httpRoot,
    message: existsSync(httpRoot) ? undefined : "HTTP schema directory not found"
  });

  checks.push(compileSchemas(commerceSchema, httpRoot));
  return checks;
}

function compileSchemas(commerceSchema: string, httpRoot: string): DoctorCheck {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(readJson(commerceSchema));
    for (const schema of httpSchemas) {
      ajv.addSchema(readJson(resolve(httpRoot, schema)));
    }
    return { name: "schema_compile", ok: true, value: "8 schemas" };
  } catch (error) {
    return {
      name: "schema_compile",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveCoreDistSpec(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const monorepoSibling = resolve(here, "..", "..", "..", "core", "dist", "spec");
  if (existsSync(monorepoSibling)) return monorepoSibling;

  const cwdCandidate = resolve(process.cwd(), "packages", "core", "dist", "spec");
  if (existsSync(cwdCandidate)) return cwdCandidate;

  return monorepoSibling;
}
