// Copyright (c) Steelyard contributors. MIT License.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../../../cli.js";
import type { CliIO } from "../../../io.js";

describe("steelyard policy lint", () => {
  it("returns 0 with no warnings on a clean policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-lint-"));
    const file = join(dir, "policy.yaml");
    writeFileSync(file, "version: 2026-06-27\nrules:\n  - name: deny-all\n    do: deny\n");

    const run = await runPolicy(["policy", "lint", file], dir);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("no warnings");
    expect(run.stderr).toBe("");
  });

  it("emits warnings without failing the lint command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-lint-"));
    const file = join(dir, "policy.yaml");
    writeFileSync(
      file,
      `
version: 2026-06-27
trusted_domains: { tier1: [example.com] }
rules:
  - name: allow-one
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1 }
`
    );

    const run = await runPolicy(["policy", "lint", "policy.yaml"], dir);

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("warning [missing_default_deny]");
  });

  it("returns JSON for warnings and schema errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-lint-"));
    const warningFile = join(dir, "warning.yaml");
    const invalidFile = join(dir, "invalid.yaml");
    writeFileSync(
      warningFile,
      `
version: 2026-06-27
rules:
  - name: allow-any
    do: allow
    rail: virtual_card
`
    );
    writeFileSync(invalidFile, "version: 1999\nrules: []\n");

    const warning = await runPolicy(["policy", "lint", warningFile, "--json"], dir);
    const invalid = await runPolicy(["policy", "lint", invalidFile, "--json"], dir);

    expect(warning.code).toBe(0);
    expect(JSON.parse(warning.stdout)).toMatchObject({ ok: true, warnings: [expect.objectContaining({ code: "missing_default_deny" })] });
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false });
  });

  it("returns usage errors for malformed policy command invocations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-lint-"));
    writeFileSync(join(dir, "policy.yaml"), "version: 2026-06-27\nrules:\n  - name: deny-all\n    do: deny\n");

    const missingPath = await runPolicy(["policy", "lint"], dir);
    const unknownSubcommand = await runPolicy(["policy", "unknown"], dir);
    const unknownOption = await runPolicy(["policy", "lint", "policy.yaml", "--bad"], dir);
    const tooManyArgs = await runPolicy(["policy", "lint", "policy.yaml", "extra.yaml"], dir);

    expect(missingPath).toMatchObject({ code: 4 });
    expect(missingPath.stderr).toContain("usage: steelyard policy lint");
    expect(unknownSubcommand).toMatchObject({ code: 4 });
    expect(unknownSubcommand.stderr).toContain("usage: steelyard policy <lint|run|audit>");
    expect(unknownOption).toMatchObject({ code: 4 });
    expect(unknownOption.stderr).toContain("unknown option");
    expect(tooManyArgs).toMatchObject({ code: 4 });
  });
});

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
