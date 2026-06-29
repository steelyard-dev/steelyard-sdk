// Copyright (c) Steelyard contributors. MIT License.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { hashEntry } from "@steelyard-dev/policy";
import { runCli } from "../../../cli.js";
import type { CliIO } from "../../../io.js";

describe("steelyard policy audit verify", () => {
  it("returns 0 for an intact data-dir audit chain", async () => {
    const dataDir = mkDataDir();
    writeChain(dataDir, [entry("i1", ""), entry("i2", "sha256:first")]);

    const run = await runPolicy(["policy", "audit", "verify", dataDir], dataDir);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("ok: hash chain intact");
  });

  it("returns 1 and reports line plus byte offset for a broken chain", async () => {
    const dataDir = mkDataDir();
    writeChain(dataDir, [entry("i1", "")]);
    const file = join(dataDir, "audit", "2026-06-28.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"i1"', '"hacked"'));

    const run = await runPolicy(["policy", "audit", "verify", dataDir], dataDir);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("break: 2026-06-28.jsonl:1:0 entry_hash_mismatch");
  });

  it("returns usage errors for malformed audit verify arguments", async () => {
    const dataDir = mkDataDir();

    const missing = await runPolicy(["policy", "audit", "verify"], dataDir);
    const extra = await runPolicy(["policy", "audit", "verify", dataDir, "extra"], dataDir);

    expect(missing).toMatchObject({ code: 4 });
    expect(extra).toMatchObject({ code: 4 });
  });
});

function mkDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "policy-audit-"));
  mkdirSync(join(dataDir, "audit"));
  return dataDir;
}

function writeChain(dataDir: string, entries: Array<Record<string, unknown>>): void {
  const [first, second] = entries;
  if (!first) return;
  const firstFull = withHash(first);
  const rows = [firstFull];
  if (second) rows.push(withHash({ ...second, prev_hash: firstFull.entry_hash }));
  writeFileSync(join(dataDir, "audit", "2026-06-28.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function entry(intent_id: string, prev_hash: string): Record<string, unknown> {
  return {
    ts: "2026-06-28T12:00:00.000Z",
    engine_version: "0.0.0",
    policy_hash: "sha256:p",
    intent_id,
    matched_rule: "r",
    counterfactuals: [],
    normalized_facts: {},
    authorization_hash: "sha256:a",
    decision: "allow",
    prev_hash
  };
}

function withHash(entryWithoutHash: Record<string, unknown>): Record<string, unknown> {
  return { ...entryWithoutHash, entry_hash: hashEntry(entryWithoutHash) };
}

async function runPolicy(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const stdin = Readable.from([]) as Readable & { isTTY?: boolean };
  stdin.isTTY = false;
  const io: CliIO = { stdin, stdout, stderr, env: process.env, cwd };
  const code = await runCli(argv, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

class MemoryWritable extends Writable {
  private chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}
