import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ChainBreak {
  file: string;
  line: number;
  offset: number;
  reason: "invalid_json" | "entry_hash_mismatch" | "prev_hash_mismatch";
}

export interface ChainVerificationResult {
  ok: boolean;
  breaks: ChainBreak[];
}

export function hashEntry(entryWithoutEntryHash: object): string {
  return `sha256:${createHash("sha256").update(canonicalJson(entryWithoutEntryHash)).digest("hex")}`;
}

export async function verifyChain(dir: string): Promise<ChainVerificationResult> {
  const breaks: ChainBreak[] = [];
  const files = auditFiles(dir);
  let prev = "";

  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineOffset = offset;
      offset += Buffer.byteLength(line ?? "", "utf8") + 1;
      if (!line) continue;

      let entry: { entry_hash?: string; prev_hash?: string };
      try {
        entry = JSON.parse(line) as { entry_hash?: string; prev_hash?: string };
      } catch {
        breaks.push({ file, line: i + 1, offset: lineOffset, reason: "invalid_json" });
        continue;
      }

      const { entry_hash, ...withoutHash } = entry;
      if (!entry_hash || hashEntry(withoutHash) !== entry_hash) {
        breaks.push({ file, line: i + 1, offset: lineOffset, reason: "entry_hash_mismatch" });
      }
      if (entry.prev_hash !== prev) {
        breaks.push({ file, line: i + 1, offset: lineOffset, reason: "prev_hash_mismatch" });
      }
      prev = entry_hash ?? "";
    }
  }

  return { ok: breaks.length === 0, breaks };
}

export function auditFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}
