// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type RequestListener, type Server as NodeServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { commerceManifest, defineCommerce, type Manifest } from "@steelyard/core";
import { manifestCommand } from "./commands/manifest.js";
import { runCli } from "./cli.js";
import { defaultIO, type CliIO } from "./io.js";

const generatedAt = "2026-06-14T00:00:00.000Z";

const nodeServers: NodeServer[] = [];

afterEach(async () => {
  while (nodeServers.length) {
    const server = nodeServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("steelyard validate", () => {
  it("validates file, stdin, module, and URL sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-cli-"));
    const doc = validDoc();
    const docPath = join(dir, "commerce.json");
    const modulePath = join(dir, "commerce.mjs");
    await writeFile(docPath, JSON.stringify(doc));
    await writeFile(modulePath, `export default ${JSON.stringify(doc)};`);
    const url = await serveJson(doc);
    const redirectUrl = await serveRedirect(url);

    const fileRun = await run(["validate", docPath], { cwd: dir });
    const stdinRun = await run(["validate", "-"], { cwd: dir, stdin: JSON.stringify(doc) });
    const moduleRun = await run(["validate", modulePath, "--module"], { cwd: dir });
    const urlRun = await run(["validate", url, "--allow-private-network"], { cwd: dir });
    const redirectRun = await run(["validate", redirectUrl, "--allow-private-network"], { cwd: dir });

    expect(fileRun.code).toBe(0);
    expect(fileRun.stdout).toContain("Valid commerce manifest");
    expect(stdinRun.code).toBe(0);
    expect(moduleRun.code).toBe(0);
    expect(urlRun.code).toBe(0);
    expect(redirectRun.code).toBe(0);
  });

  it("reports JSON validation results and strict root-field failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-cli-"));
    const doc = validDoc();
    const validPath = join(dir, "valid.json");
    const strictPath = join(dir, "strict.json");
    const invalidPath = join(dir, "invalid.json");
    await writeFile(validPath, JSON.stringify(doc));
    await writeFile(strictPath, JSON.stringify({ ...doc, extension: true }));
    await writeFile(
      invalidPath,
      JSON.stringify({
        ...doc,
        content_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
      })
    );

    const valid = await run(["validate", validPath, "--json"], { cwd: dir });
    const strict = await run(["validate", strictPath, "--strict"], { cwd: dir });
    const invalid = await run(["validate", invalidPath, "--json"], { cwd: dir });

    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, schema_version: "0.1" });
    expect(strict.code).toBe(1);
    expect(strict.stderr).toContain("unknown root-level field");
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).errors[0].message).toContain("sha256");
  });

  it("maps source failures to the documented exit codes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-cli-"));
    const missing = await run(["validate", "missing.json"], { cwd: dir });
    const tty = await run(["validate", "-"], { cwd: dir, stdinIsTTY: true });
    const privateUrl = await serveJson(validDoc());
    const privateRejected = await run(["validate", privateUrl], { cwd: dir });
    const notFound = await run(["validate", await serveStatus(404), "--allow-private-network"], { cwd: dir });
    const serverError = await run(["validate", await serveStatus(500), "--allow-private-network"], { cwd: dir });
    const badJsonPath = join(dir, "bad.json");
    await writeFile(badJsonPath, "{");
    const badJson = await run(["validate", badJsonPath, "--json"], { cwd: dir });
    const malformedUrl = await run(["validate", "http://"], { cwd: dir });
    const privateRange = await run(["validate", "http://192.168.0.1/source.json"], { cwd: dir });
    const timeout = await run(["validate", await serveSlow(), "--allow-private-network"], {
      cwd: dir,
      env: { STEELYARD_CLI_TIMEOUT_MS: "20" }
    });

    expect(missing.code).toBe(2);
    expect(tty.code).toBe(4);
    expect(privateRejected.code).toBe(4);
    expect(notFound.code).toBe(2);
    expect(serverError.code).toBe(3);
    expect(badJson.code).toBe(4);
    expect(JSON.parse(badJson.stdout).errors[0].message).toContain("JSON");
    expect(malformedUrl.code).toBe(4);
    expect(privateRange.code).toBe(4);
    expect(timeout.code).toBe(3);
  });
});

describe("steelyard manifest", () => {
  it("generates manifests from file, stdin, and named module exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-cli-"));
    const manifest = v03Manifest();
    const manifestPath = join(dir, "manifest.json");
    const modulePath = join(dir, "catalog.mjs");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(modulePath, `export const coffeeShopManifest = ${JSON.stringify(manifest)};`);

    const fileRun = await run(["manifest", manifestPath, "--generated-at", generatedAt], { cwd: dir });
    const stdinRun = await run(["manifest", "-", "--generated-at", generatedAt], {
      cwd: dir,
      stdin: JSON.stringify(manifest)
    });
    const moduleRun = await run(
      ["manifest", modulePath, "--module", "--export", "coffeeShopManifest", "--generated-at", generatedAt],
      { cwd: dir }
    );

    expect(fileRun.code).toBe(0);
    expect(JSON.parse(fileRun.stdout).content_hash).toMatch(/^sha256:/);
    expect(stdinRun.stdout).toBe(fileRun.stdout);
    expect(moduleRun.stdout).toBe(fileRun.stdout);
  });

  it("supports pretty output, peers, protocol versions, and deterministic generated_at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-cli-"));
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(v03Manifest()));
    const args = [
      "manifest",
      manifestPath,
      "--peer",
      "http=https://coffee.example/commerce",
      "--protocol-version",
      "http=0.1",
      "--generated-at",
      generatedAt,
      "--pretty"
    ];

    const first = await run(args, { cwd: dir });
    const second = await run(args, { cwd: dir });
    const doc = JSON.parse(first.stdout);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain('\n  "schema_version"');
    expect(first.stdout).toBe(second.stdout);
    expect(doc.peers.http).toEqual({ url: "https://coffee.example/commerce", protocol_version: "0.1" });
    expect(doc.generated_at).toBe(generatedAt);
  });

  it("rejects missing peer protocol versions, TypeScript module sources, and bad args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-cli-"));
    const manifestPath = join(dir, "manifest.json");
    const tsPath = join(dir, "catalog.ts");
    await writeFile(manifestPath, JSON.stringify(v03Manifest()));
    await writeFile(tsPath, "export default {};");

    const missingVersion = await run(["manifest", manifestPath, "--peer", "http=https://x"], { cwd: dir });
    const tsModule = await run(["manifest", tsPath, "--module"], { cwd: dir });
    const badModule = await run(["manifest", manifestPath, "--module"], { cwd: dir });
    const badCommand = await run(["unknown"], { cwd: dir });
    const missingSource = await run(["manifest"], { cwd: dir });

    expect(missingVersion.code).toBe(4);
    expect(missingVersion.stderr).toContain("requires --protocol-version");
    expect(tsModule.code).toBe(4);
    expect(tsModule.stderr).toContain("use tsx");
    expect(badModule.code).toBe(4);
    expect(badCommand.code).toBe(4);
    expect(missingSource.code).toBe(4);
  });
});

describe("steelyard doctor", () => {
  it("reports read-side setup checks in text and JSON modes", async () => {
    const text = await run(["doctor"]);
    const json = await run(["doctor", "--json"]);

    expect(text.code).toBe(0);
    expect(text.stdout).toContain("PASS node_version");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true });
    expect(defaultIO().cwd).toBe(process.cwd());
  });

  it("exposes command helpers for missing-source integrations", async () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const result = await manifestCommand(undefined, {}, {
      stdin: Readable.from([]) as Readable & { isTTY?: boolean },
      stdout,
      stderr,
      env: process.env,
      cwd: process.cwd()
    });

    expect(result.code).toBe(4);
    expect(stderr.text()).toContain("usage: steelyard manifest");
  });
});

async function run(
  argv: string[],
  opts: { cwd?: string; stdin?: string; stdinIsTTY?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const stdin = Readable.from(opts.stdin === undefined ? [] : [opts.stdin]) as Readable & { isTTY?: boolean };
  stdin.isTTY = opts.stdinIsTTY ?? false;
  const io: CliIO = {
    stdin,
    stdout,
    stderr,
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd ?? process.cwd()
  };
  const code = await runCli(argv, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function v03Manifest(): Manifest {
  return defineCommerce({
    identity: { name: "Coffee Shop", domain: "coffee.example", currencies: ["usd"] },
    offers: [
      {
        id: "latte",
        title: "Latte",
        categories: ["coffee"],
        pricing: [{ kind: "one_time", amount: 550, currency: "usd" }]
      }
    ],
    policies: [{ type: "returns", summary: "No returns on prepared drinks." }]
  });
}

function validDoc() {
  return commerceManifest(v03Manifest(), { generatedAt });
}

async function serveJson(body: unknown): Promise<string> {
  return await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
}

async function serveStatus(status: number): Promise<string> {
  return await serve((_req, res) => {
    res.writeHead(status);
    res.end();
  });
}

async function serveRedirect(location: string): Promise<string> {
  return await serve((_req, res) => {
    res.writeHead(302, { location });
    res.end();
  });
}

async function serveSlow(): Promise<string> {
  return await serve(() => undefined);
}

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  nodeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/source.json`;
}

class MemoryWritable extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
