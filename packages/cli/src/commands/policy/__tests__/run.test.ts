// Copyright (c) Steelyard contributors. MIT License.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../../../cli.js";
import type { CliIO } from "../../../io.js";
import { policyRunCommand } from "../run.js";

const POLICY = "version: 2026-06-27\nrules:\n  - name: deny-all\n    do: deny\n";
const RELOADED = "version: 2026-06-27\ntrusted_domains: { tier1: [example.com] }\nrules:\n  - name: deny-all\n    do: deny\n";

describe("steelyard policy run", () => {
  it("starts the engine, prints socket and token, reloads on SIGHUP, and shuts down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-run-"));
    const policy = join(dir, "policy.yaml");
    const dataDir = join(dir, "data");
    writeFileSync(policy, POLICY);
    const signals = new EventEmitter();
    const io = captureIo(dir);

    const result = await policyRunCommand(
      {
        policy,
        dataDir,
        signalSource: signals,
        waitForShutdown: async () => {
          writeFileSync(policy, RELOADED);
          signals.emit("SIGHUP");
        }
      },
      io
    );

    expect(result.code).toBe(0);
    expect(io.stdout.text()).toContain(`engine started; data dir=${dataDir}`);
    expect(io.stdout.text()).toContain(`socket=${join(dataDir, "policy.sock")}`);
    expect(io.stdout.text()).toContain("caller_token=");
    expect(io.stdout.text()).toContain("policy reloaded; policy_hash=sha256:");
    expect(io.stdout.text()).toContain("shutting down");
    expect(existsSync(join(dataDir, "policy.sock"))).toBe(false);
  });

  it("fails closed when the policy cannot be loaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-run-"));
    const io = captureIo(dir);

    const result = await policyRunCommand({ policy: join(dir, "missing.yaml"), dataDir: join(dir, "data"), waitForShutdown: async () => {} }, io);

    expect(result.code).toBe(1);
    expect(io.stderr.text()).toContain("error:");
  });

  it("returns usage errors for malformed run arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-run-"));

    const unknown = await runPolicy(["policy", "run", "--bad"], dir);
    const missingValue = await runPolicy(["policy", "run", "--policy"], dir);

    expect(unknown).toMatchObject({ code: 4 });
    expect(unknown.stderr).toContain("usage: steelyard policy run");
    expect(missingValue).toMatchObject({ code: 4 });
  });
});

async function runPolicy(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = captureIo(cwd);
  const code = await runCli(argv, io);
  return { code, stdout: io.stdout.text(), stderr: io.stderr.text() };
}

function captureIo(cwd: string): CliIO & { stdout: MemoryWritable; stderr: MemoryWritable } {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const stdin = Readable.from([]) as Readable & { isTTY?: boolean };
  stdin.isTTY = false;
  return { stdin, stdout, stderr, env: process.env, cwd };
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
