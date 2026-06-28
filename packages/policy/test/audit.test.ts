import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../src/audit/chain.js";
import { FileAuditSink } from "../src/audit/file-sink.js";
import type { AuditEntryBase } from "../src/audit/sink.js";

function baseEntry(intent_id: string, ts = "2026-06-28T12:00:00.000Z"): AuditEntryBase {
  return {
    ts,
    engine_version: "0.0.0",
    policy_hash: "sha256:p",
    intent_id,
    matched_rule: "r",
    counterfactuals: [],
    normalized_facts: {},
    authorization_hash: "sha256:a",
    decision: "allow"
  };
}

describe("FileAuditSink", () => {
  it("appends entries with chained hashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const clock = { now: () => new Date("2026-06-28T12:00:00Z") };
    const sink = new FileAuditSink(dir, clock);
    const first = await sink.append(baseEntry("i1"));
    const second = await sink.append(baseEntry("i2"));
    expect(second.prev_hash).toBe(first.entry_hash);
    await expect(verifyChain(dir)).resolves.toEqual({ ok: true, breaks: [] });
  });

  it("chains across daily files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const clock = { now: () => new Date("2026-06-29T12:00:00Z") };
    const sink = new FileAuditSink(dir, clock);
    const first = await sink.append(baseEntry("i1", "2026-06-28T23:59:59.000Z"));
    const second = await sink.append(baseEntry("i2", "2026-06-29T00:00:01.000Z"));
    expect(second.prev_hash).toBe(first.entry_hash);
    expect(readFileSync(join(dir, "2026-06-28.jsonl"), "utf8")).toContain(first.entry_hash);
    expect(readFileSync(join(dir, "2026-06-29.jsonl"), "utf8")).toContain(second.entry_hash);
  });

  it("amend writes a new entry referencing prior entry_hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const clock = { now: () => new Date("2026-06-28T12:01:00Z") };
    const sink = new FileAuditSink(dir, clock);
    const first = await sink.append(baseEntry("i1"));
    const amended = await sink.amend(first.entry_hash, {
      settlement_events: [{ event_id: "evt_1", ts: "2026-06-28T12:00:30Z", kind: "captured" }]
    });
    expect(amended.amends).toBe(first.entry_hash);
    expect(amended.intent_id).toBe("i1");
    expect(amended.prev_hash).toBe(first.entry_hash);
  });

  it("loads tail hash when reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const clock = { now: () => new Date("2026-06-28T12:00:00Z") };
    const firstSink = new FileAuditSink(dir, clock);
    const first = await firstSink.append(baseEntry("i1"));
    const secondSink = new FileAuditSink(dir, clock);
    const second = await secondSink.append(baseEntry("i2"));
    expect(second.prev_hash).toBe(first.entry_hash);
  });

  it("verifyChain detects edits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const clock = { now: () => new Date("2026-06-28T12:00:00Z") };
    const sink = new FileAuditSink(dir, clock);
    await sink.append(baseEntry("i1"));
    await sink.append(baseEntry("i2"));
    const file = join(dir, "2026-06-28.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    lines[0] = lines[0]?.replace('"i1"', '"hacked"') ?? "";
    writeFileSync(file, `${lines.join("\n")}\n`);
    const result = await verifyChain(dir);
    expect(result.ok).toBe(false);
    expect(result.breaks.some((chainBreak) => chainBreak.reason === "entry_hash_mismatch")).toBe(true);
  });

  it("verifyChain detects invalid JSON and broken prev_hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    writeFileSync(join(dir, "2026-06-28.jsonl"), '{"entry_hash":"sha256:x","prev_hash":""}\nnot-json\n');
    const result = await verifyChain(dir);
    expect(result.ok).toBe(false);
    expect(result.breaks.map((chainBreak) => chainBreak.reason)).toContain("invalid_json");
    expect(result.breaks.map((chainBreak) => chainBreak.reason)).toContain("entry_hash_mismatch");
  });

  it("rejects amendments for unknown entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const sink = new FileAuditSink(dir, { now: () => new Date("2026-06-28T12:00:00Z") });
    await expect(sink.amend("sha256:missing", { settlement_events: [] })).rejects.toThrow(/not found/);
  });
});
