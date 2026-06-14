// Copyright (c) Steelyard contributors. MIT License.
import {
  COMMERCE_MANIFEST_SCHEMA_VERSION,
  validateCommerceManifest,
  type CommerceManifestDoc
} from "@steelyard/core";
import type { CommandResult, CliIO } from "../io.js";
import { writeLine } from "../io.js";
import { envClock, loadJsonSource, SourceError, type SourceOptions } from "../source.js";

export interface ValidateOptions extends SourceOptions {
  json?: boolean;
  strict?: boolean;
}

const ROOT_FIELDS = new Set([
  "$schema",
  "schema_version",
  "generated_at",
  "identity",
  "offers",
  "policies",
  "peers",
  "content_hash"
]);

export async function validateCommand(source: string | undefined, opts: ValidateOptions, io: CliIO): Promise<CommandResult> {
  if (!source) return badArgs("usage: steelyard validate <source>", io, opts.json);
  try {
    envClock(io);
    const doc = await loadJsonSource(source, opts, io);
    const strictErrors = opts.strict ? strictRootErrors(doc) : [];
    const result = validateCommerceManifest(doc);
    const errors = [
      ...strictErrors,
      ...result.errors.map((error) => ({
        path: error.instancePath || "(root)",
        message: error.message ?? error.keyword
      }))
    ];

    if (result.valid && errors.length === 0) {
      const validDoc = result.doc as CommerceManifestDoc;
      if (opts.json) {
        writeLine(
          io.stdout,
          JSON.stringify({
            valid: true,
            schema_version: validDoc.schema_version,
            content_hash: validDoc.content_hash,
            errors: []
          })
        );
      } else {
        writeLine(
          io.stdout,
          `✓ Valid commerce manifest (schema ${COMMERCE_MANIFEST_SCHEMA_VERSION}, content_hash ${validDoc.content_hash})`
        );
      }
      return { code: 0 };
    }

    if (opts.json) {
      writeLine(io.stdout, JSON.stringify({ valid: false, errors }));
    } else {
      writeLine(io.stderr, `✗ Invalid commerce manifest at ${source}`);
      errors.forEach((error, index) => {
        writeLine(io.stderr, `  Error ${index + 1}: ${error.path}: ${error.message}`);
      });
    }
    return { code: 1 };
  } catch (error) {
    return handleCommandError(error, io, opts.json);
  }
}

export function handleCommandError(error: unknown, io: CliIO, json?: boolean): CommandResult {
  if (error instanceof SourceError) {
    if (json) writeLine(io.stdout, JSON.stringify({ valid: false, errors: [{ message: error.message }] }));
    else writeLine(io.stderr, error.message);
    return { code: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) writeLine(io.stdout, JSON.stringify({ valid: false, errors: [{ message }] }));
  else writeLine(io.stderr, message);
  return { code: 4 };
}

function strictRootErrors(doc: unknown): { path: string; message: string }[] {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
  return Object.keys(doc)
    .filter((key) => !ROOT_FIELDS.has(key))
    .map((key) => ({
      path: `/${key}`,
      message: "unknown root-level field in strict mode"
    }));
}

function badArgs(message: string, io: CliIO, json?: boolean): CommandResult {
  if (json) writeLine(io.stdout, JSON.stringify({ valid: false, errors: [{ message }] }));
  else writeLine(io.stderr, message);
  return { code: 4 };
}
