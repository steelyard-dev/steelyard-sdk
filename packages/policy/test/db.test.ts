import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openLedger } from "../src/ledger/db.js";

describe("openLedger", () => {
  it("creates the schema at version 1 on a fresh file", () => {
    const db = openLedger(":memory:");
    const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(version.version).toBe(1);
    db.close();
  });

  it("creates all v0.1 tables required by LE1", () => {
    const db = openLedger(":memory:");
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual([
      "approvals",
      "audit",
      "credentials",
      "fx_quotes",
      "policy_snapshots",
      "reservations",
      "schema_version"
    ]);
    db.close();
  });

  it("is idempotent on re-open", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-db-"));
    const path = join(dir, "policy.sqlite");
    const first = openLedger(path);
    first.close();
    const second = openLedger(path);
    const version = second.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(version.version).toBe(1);
    second.close();
  });

  it("enables WAL and foreign keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-db-"));
    const db = openLedger(join(dir, "policy.sqlite"));
    expect((db.pragma("journal_mode") as Array<{ journal_mode: string }>)[0]?.journal_mode.toLowerCase()).toBe("wal");
    expect((db.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]?.foreign_keys).toBe(1);
    db.close();
  });
});
