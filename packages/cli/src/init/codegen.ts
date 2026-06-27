// Copyright (c) Steelyard contributors. MIT License.
//
// Transactional file-plan writer. Stages writes, rolls back on first failure.
// "Transactional" here means: either every file in the plan exists with the
// requested contents, or no file from the plan exists. Pre-existing files
// untouched by the plan are not affected either way.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface WritePlanEntry {
  path: string;
  contents: string;
}

export interface WritePlanOptions {
  overwrite: "fail" | "replace";
}

export interface WritePlanResult {
  ok: boolean;
  written: string[];
  error?: { path: string; message: string };
}

interface PreExisting {
  path: string;
  contents: string;
}

export async function writePlanTransactional(
  root: string,
  plan: WritePlanEntry[],
  opts: WritePlanOptions
): Promise<WritePlanResult> {
  const written: string[] = [];
  const preExisting: PreExisting[] = [];

  try {
    for (const entry of plan) {
      const fullPath = resolve(root, entry.path);
      const existed = await pathExists(fullPath);
      if (existed) {
        if (opts.overwrite === "fail") {
          throw new Error(`file already exists: ${entry.path}`);
        }
        preExisting.push({ path: fullPath, contents: await readFile(fullPath, "utf8") });
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, entry.contents, "utf8");
      written.push(entry.path);
    }
    return { ok: true, written };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The failing entry is the (written.length)th in the plan (0-indexed).
    const failingPath = plan[written.length]?.path ?? "(unknown)";
    // Roll back: remove every file we created in this batch (those not in preExisting).
    const preExistingSet = new Set(preExisting.map((p) => p.path));
    for (const rel of written) {
      const fullPath = resolve(root, rel);
      if (!preExistingSet.has(fullPath)) {
        await rm(fullPath, { force: true });
      }
    }
    // Restore any pre-existing files we overwrote.
    for (const item of preExisting) {
      await writeFile(item.path, item.contents, "utf8");
    }
    return {
      ok: false,
      written: [],
      error: { path: failingPath, message }
    };
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
