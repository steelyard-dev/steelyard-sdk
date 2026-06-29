// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { systemClock } from "@steelyard-dev/core";
import { lock } from "proper-lockfile";

export type NonceConsumeFailureReason = "missing" | "expired" | "session_mismatch" | "already_consumed";

export type NonceConsumeResult =
  | { ok: true }
  | { ok: false; reason: NonceConsumeFailureReason };

export interface NonceStore {
  issue(args: { session_id: string; ttlSeconds?: number }): Promise<{ nonce: string; expires_at: string }>;
  consume(args: { nonce: string; session_id: string }): Promise<NonceConsumeResult>;
}

export function memoryNonceStore(opts: { ttlSeconds?: number; clock?: () => Date } = {}): NonceStore {
  return new MemoryNonceStore(opts.ttlSeconds ?? DEFAULT_NONCE_TTL_SECONDS, opts.clock ?? systemClock);
}

export function fileNonceStore(opts: { dir: string; ttlSeconds?: number; clock?: () => Date }): NonceStore {
  return new FileNonceStore(opts.dir, opts.ttlSeconds ?? DEFAULT_NONCE_TTL_SECONDS, opts.clock ?? systemClock);
}

const DEFAULT_NONCE_TTL_SECONDS = 900;
const NONCE_BYTES = 32;

interface NonceRecord {
  nonceHash: string;
  session_id: string;
  issued_at: string;
  expires_at: string;
  consumed_at?: string;
}

class MemoryNonceStore implements NonceStore {
  readonly #records = new Map<string, NonceRecord>();

  constructor(
    readonly ttlSeconds: number,
    readonly clock: () => Date
  ) {}

  async issue(args: { session_id: string; ttlSeconds?: number }): Promise<{ nonce: string; expires_at: string }> {
    const sessionId = requiredString(args.session_id, "session_id");
    const ttlSeconds = validTtlSeconds(args.ttlSeconds ?? this.ttlSeconds);
    this.pruneExpired();

    let nonce = newNonce();
    while (this.#records.has(nonce)) nonce = newNonce();

    const record = createNonceRecord({
      nonce,
      sessionId,
      now: this.clock(),
      ttlSeconds
    });
    this.#records.set(nonce, record);
    return { nonce, expires_at: record.expires_at };
  }

  async consume(args: { nonce: string; session_id: string }): Promise<NonceConsumeResult> {
    const nonce = requiredString(args.nonce, "nonce");
    const sessionId = requiredString(args.session_id, "session_id");
    const record = this.#records.get(nonce);
    if (!record) return { ok: false, reason: "missing" };

    const result = consumeRecord(record, sessionId, this.clock());
    if (result.ok) {
      this.#records.set(nonce, { ...record, consumed_at: this.clock().toISOString() });
      return result;
    }
    if (result.reason === "expired") this.#records.delete(nonce);
    return result;
  }

  private pruneExpired(): void {
    const now = this.clock();
    for (const [nonce, record] of this.#records) {
      if (isExpired(record, now)) this.#records.delete(nonce);
    }
  }
}

class FileNonceStore implements NonceStore {
  readonly #dir: string;
  readonly #ttlSeconds: number;
  readonly #clock: () => Date;

  constructor(dir: string, ttlSeconds: number, clock: () => Date) {
    this.#dir = dir;
    this.#ttlSeconds = ttlSeconds;
    this.#clock = clock;
  }

  async issue(args: { session_id: string; ttlSeconds?: number }): Promise<{ nonce: string; expires_at: string }> {
    const sessionId = requiredString(args.session_id, "session_id");
    const ttlSeconds = validTtlSeconds(args.ttlSeconds ?? this.#ttlSeconds);
    await ensureSecureDir(this.#dir);
    await this.pruneExpired();

    const nonce = newNonce();
    const record = createNonceRecord({
      nonce,
      sessionId,
      now: this.#clock(),
      ttlSeconds
    });
    await writeJsonSecure(this.recordPath(nonce), record);
    return { nonce, expires_at: record.expires_at };
  }

  async consume(args: { nonce: string; session_id: string }): Promise<NonceConsumeResult> {
    const nonce = requiredString(args.nonce, "nonce");
    const sessionId = requiredString(args.session_id, "session_id");
    await ensureSecureDir(this.#dir);
    const lockPath = this.lockPath(nonce);
    await ensureLockTarget(lockPath);
    return await withPathLock(lockPath, async () => {
      const recordPath = this.recordPath(nonce);
      const record = await readRecord(recordPath);
      if (!record) return { ok: false, reason: "missing" };

      const result = consumeRecord(record, sessionId, this.#clock());
      if (result.ok) {
        await writeJsonSecure(recordPath, { ...record, consumed_at: this.#clock().toISOString() });
        return result;
      }
      if (result.reason === "expired") await rm(recordPath, { force: true });
      return result;
    });
  }

  private async pruneExpired(): Promise<void> {
    const names = await readdir(this.#dir);
    await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
          const path = join(this.#dir, name);
          const record = await readRecord(path);
          if (record && isExpired(record, this.#clock())) await rm(path, { force: true });
        })
    );
  }

  private recordPath(nonce: string): string {
    return join(this.#dir, `${hashNonce(nonce)}.json`);
  }

  private lockPath(nonce: string): string {
    return join(this.#dir, `${hashNonce(nonce)}.lock`);
  }
}

function createNonceRecord(args: {
  nonce: string;
  sessionId: string;
  now: Date;
  ttlSeconds: number;
}): NonceRecord {
  return {
    nonceHash: hashNonce(args.nonce),
    session_id: args.sessionId,
    issued_at: args.now.toISOString(),
    expires_at: new Date(args.now.getTime() + args.ttlSeconds * 1000).toISOString()
  };
}

function consumeRecord(record: NonceRecord, sessionId: string, now: Date): NonceConsumeResult {
  if (isExpired(record, now)) return { ok: false, reason: "expired" };
  if (record.session_id !== sessionId) return { ok: false, reason: "session_mismatch" };
  if (record.consumed_at) return { ok: false, reason: "already_consumed" };
  return { ok: true };
}

function isExpired(record: NonceRecord, now: Date): boolean {
  return new Date(record.expires_at).getTime() <= now.getTime();
}

function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function requiredString(value: string, name: string): string {
  if (!value) throw new Error(`nonce store ${name} is required`);
  return value;
}

function validTtlSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("nonce store ttlSeconds must be a positive integer");
  return value;
}

async function readRecord(path: string): Promise<NonceRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as NonceRecord;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

const lockQueues = new Map<string, Promise<void>>();

async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(path) ?? Promise.resolve();
  let releaseQueue: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  lockQueues.set(path, queued);
  await previous.catch(() => undefined);

  const releaseFile = await lock(path, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 }
  });
  try {
    return await fn();
  } finally {
    await releaseFile();
    releaseQueue();
    if (lockQueues.get(path) === queued) lockQueues.delete(path);
  }
}

async function writeJsonSecure(path: string, value: unknown): Promise<void> {
  await ensureSecureDir(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmodBestEffort(tmp, 0o600);
  await rename(tmp, path);
  await chmodBestEffort(path, 0o600);
}

async function ensureSecureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmodBestEffort(dir, 0o700);
}

async function ensureLockTarget(path: string): Promise<void> {
  await ensureSecureDir(dirname(path));
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmodBestEffort(path, 0o600);
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    /* c8 ignore next 3 -- non-permission chmod failures are filesystem/platform failures. */
    if (code !== "EPERM" && code !== "EACCES") throw error;
  }
}
