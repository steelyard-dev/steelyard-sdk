// Copyright (c) Steelyard contributors. MIT License.
import { promises as dns } from "node:dns";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliIO } from "./io.js";

export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const UTC_INSTANT_WITH_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type SourceFailureCode = 2 | 3 | 4;

export class SourceError extends Error {
  constructor(
    readonly code: SourceFailureCode,
    message: string
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface SourceOptions {
  module?: boolean;
  exportName?: string;
  allowPrivateNetwork?: boolean;
  interactive?: boolean;
}

export interface FetchJsonOptions {
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
}

export async function loadJsonSource(source: string, opts: SourceOptions, io: CliIO): Promise<unknown> {
  if (opts.module) return loadModuleSource(source, opts.exportName, io);
  if (source === "-") return JSON.parse(await readStdin(io, opts.interactive));
  if (isHttpUrl(source)) return await fetchJson(source, { allowPrivateNetwork: opts.allowPrivateNetwork, timeoutMs: timeoutMs(io) });
  return JSON.parse(await readFileSource(source, io));
}

export async function readStdin(io: CliIO, interactive?: boolean): Promise<string> {
  if (io.stdin.isTTY && !interactive) {
    throw new SourceError(4, "stdin is a TTY; pass JSON via pipe or use --interactive");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of io.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_SOURCE_BYTES) throw new SourceError(4, "stdin exceeds 5 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readFileSource(source: string, io: CliIO): Promise<string> {
  const path = resolve(io.cwd, source);
  if (!existsSync(path)) throw new SourceError(2, `source not found: ${source}`);
  const buffer = await readFile(path);
  if (buffer.length > MAX_SOURCE_BYTES) throw new SourceError(4, "source exceeds 5 MiB");
  return buffer.toString("utf8");
}

export async function loadModuleSource(source: string, exportName: string | undefined, io: CliIO): Promise<unknown> {
  if (source.endsWith(".ts") || source.endsWith(".tsx")) {
    throw new SourceError(4, "TypeScript module sources are not supported at runtime; use tsx");
  }
  if (!source.endsWith(".js") && !source.endsWith(".mjs")) {
    throw new SourceError(4, "--module sources must be .js or .mjs files");
  }

  const path = resolve(io.cwd, source);
  if (!existsSync(path)) throw new SourceError(2, `source not found: ${source}`);
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const value = exportName ? mod[exportName] : mod.default;
  if (value === undefined) {
    throw new SourceError(4, exportName ? `module export not found: ${exportName}` : "module default export not found");
  }
  return value;
}

export async function fetchJson(source: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const raw = await fetchText(source, opts);
  return JSON.parse(raw);
}

export async function fetchText(source: string, opts: FetchJsonOptions = {}): Promise<string> {
  let current = parseHttpUrl(source);
  const timeout = opts.timeoutMs ?? 10_000;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current, opts.allowPrivateNetwork);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetch(current, { redirect: "manual", signal: controller.signal });
    } catch (error) {
      throw new SourceError(3, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      if (hop === MAX_REDIRECTS) throw new SourceError(3, "too many redirects");
      current = parseHttpUrl(new URL(response.headers.get("location")!, current).href);
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      throw new SourceError(2, `source not found: HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new SourceError(3, `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return "";

    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > MAX_SOURCE_BYTES) throw new SourceError(3, "response exceeds 5 MiB");
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  throw new SourceError(3, "too many redirects");
}

export function validateGeneratedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!UTC_INSTANT_WITH_MILLIS.test(value)) {
    throw new SourceError(4, "generated timestamp must be a UTC instant with milliseconds");
  }
  return value;
}

export function timeoutMs(io: CliIO): number {
  const raw = io.env.STEELYARD_CLI_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

export function envClock(io: CliIO): string | undefined {
  return validateGeneratedAt(io.env.STEELYARD_CLI_CLOCK);
}

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function parseHttpUrl(source: string): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new SourceError(4, `malformed source URL: ${source}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceError(4, `unsupported URL scheme: ${url.protocol}`);
  }
  return url.href;
}

async function assertPublicHttpUrl(source: string, allowPrivateNetwork?: boolean): Promise<void> {
  const url = new URL(source);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceError(4, `unsupported URL scheme: ${url.protocol}`);
  }
  if (allowPrivateNetwork) return;

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true }).catch((error) => {
        throw new SourceError(3, error instanceof Error ? error.message : String(error));
      });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new SourceError(4, `refusing private-network URL: ${url.hostname}`);
  }
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map((part) => Number(part));
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("fc") || lower.startsWith("fd");
}
