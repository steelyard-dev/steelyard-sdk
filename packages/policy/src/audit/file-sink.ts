import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../ledger/reservations.js";
import { auditFiles, hashEntry } from "./chain.js";
import type { AuditEntry, AuditEntryBase, AuditSink } from "./sink.js";

export class FileAuditSink implements AuditSink {
  private lastHash = "";

  constructor(
    private readonly dir: string,
    private readonly clock: Clock
  ) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.lastHash = this.tailHash();
  }

  async append(entry: AuditEntryBase): Promise<AuditEntry> {
    return this.write(entry);
  }

  async amend(prevEntryHash: string, patch: Partial<AuditEntryBase>): Promise<AuditEntry> {
    const previous = this.findEntry(prevEntryHash);
    if (!previous) throw new Error(`audit entry not found: ${prevEntryHash}`);
    const { entry_hash: _entryHash, prev_hash: _prevHash, ...previousBase } = previous;
    return this.write({
      ...previousBase,
      ...patch,
      ts: patch.ts ?? this.clock.now().toISOString(),
      amends: prevEntryHash
    });
  }

  private write(entry: AuditEntryBase): AuditEntry {
    const withoutHash = { ...entry, prev_hash: this.lastHash };
    const entry_hash = hashEntry(withoutHash);
    const full = { ...withoutHash, entry_hash };
    appendFileSync(this.pathForTs(full.ts), `${JSON.stringify(full, auditJsonReplacer)}\n`);
    this.lastHash = entry_hash;
    return full;
  }

  private pathForTs(ts: string): string {
    return join(this.dir, `${ts.slice(0, 10)}.jsonl`);
  }

  private tailHash(): string {
    const files = auditFiles(this.dir);
    if (files.length === 0) return "";
    const lastFile = files.at(-1);
    if (!lastFile) return "";
    const lastLine = readFileSync(join(this.dir, lastFile), "utf8").trim().split("\n").filter(Boolean).at(-1);
    if (!lastLine) return "";
    return (JSON.parse(lastLine) as { entry_hash: string }).entry_hash;
  }

  private findEntry(entryHash: string): AuditEntry | undefined {
    for (const file of auditFiles(this.dir)) {
      const lines = readFileSync(join(this.dir, file), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.entry_hash === entryHash) return entry;
      }
    }
    return undefined;
  }
}

function auditJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}
