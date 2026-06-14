// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lock } from "proper-lockfile";

export interface IdempotencyResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyStore {
  remember(
    key: string,
    bodyHash: string,
    fn: () => Promise<IdempotencyResponse>
  ): Promise<IdempotencyResponse>;
}

export class IdempotencyConflict extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`idempotency key conflict: ${key}`);
    this.name = "IdempotencyConflict";
    this.key = key;
  }
}

export function memoryIdempotencyStore(opts: { ttlSeconds?: number; clock?: () => Date } = {}): IdempotencyStore {
  return new MemoryIdempotencyStore(opts.ttlSeconds ?? 86_400, opts.clock ?? (() => new Date()));
}

export function fileIdempotencyStore(opts: {
  dir: string;
  ttlSeconds?: number;
  clock?: () => Date;
}): IdempotencyStore {
  return new FileIdempotencyStore(opts.dir, opts.ttlSeconds ?? 86_400, opts.clock ?? (() => new Date()));
}

interface CacheRecord {
  key: string;
  bodyHash: string;
  response: IdempotencyResponse;
  createdAt: string;
  expiresAt: string;
}

class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #cache = new Map<string, CacheRecord>();
  readonly #inFlight = new Map<string, { bodyHash: string; promise: Promise<IdempotencyResponse> }>();

  constructor(
    readonly ttlSeconds: number,
    readonly clock: () => Date
  ) {}

  async remember(
    key: string,
    bodyHash: string,
    fn: () => Promise<IdempotencyResponse>
  ): Promise<IdempotencyResponse> {
    this.pruneExpired();
    const cached = this.#cache.get(key);
    if (cached) return replayOrConflict(cached, key, bodyHash);

    const flight = this.#inFlight.get(key);
    if (flight) {
      if (flight.bodyHash !== bodyHash) throw new IdempotencyConflict(key);
      return cloneResponse(await flight.promise);
    }

    const promise = this.runAndRemember(key, bodyHash, fn);
    this.#inFlight.set(key, { bodyHash, promise });
    try {
      return cloneResponse(await promise);
    } finally {
      this.#inFlight.delete(key);
    }
  }

  private async runAndRemember(
    key: string,
    bodyHash: string,
    fn: () => Promise<IdempotencyResponse>
  ): Promise<IdempotencyResponse> {
    const response = normalizeResponse(await fn());
    const now = this.clock();
    this.#cache.set(key, {
      key,
      bodyHash,
      response,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString()
    });
    return cloneResponse(response);
  }

  private pruneExpired(): void {
    const now = this.clock().getTime();
    for (const [key, record] of this.#cache) {
      if (new Date(record.expiresAt).getTime() <= now) this.#cache.delete(key);
    }
  }
}

class FileIdempotencyStore implements IdempotencyStore {
  readonly #dir: string;
  readonly #ttlSeconds: number;
  readonly #clock: () => Date;
  readonly #inFlight = new Map<string, { bodyHash: string; promise: Promise<IdempotencyResponse> }>();

  constructor(dir: string, ttlSeconds: number, clock: () => Date) {
    this.#dir = dir;
    this.#ttlSeconds = ttlSeconds;
    this.#clock = clock;
  }

  async remember(
    key: string,
    bodyHash: string,
    fn: () => Promise<IdempotencyResponse>
  ): Promise<IdempotencyResponse> {
    const flight = this.#inFlight.get(key);
    if (flight) {
      if (flight.bodyHash !== bodyHash) throw new IdempotencyConflict(key);
      return cloneResponse(await flight.promise);
    }
    const promise = this.rememberLocked(key, bodyHash, fn);
    this.#inFlight.set(key, { bodyHash, promise });
    try {
      return cloneResponse(await promise);
    } finally {
      this.#inFlight.delete(key);
    }
  }

  private async rememberLocked(
    key: string,
    bodyHash: string,
    fn: () => Promise<IdempotencyResponse>
  ): Promise<IdempotencyResponse> {
    await ensureSecureDir(this.#dir);
    const lockPath = this.lockPath(key);
    await ensureLockTarget(lockPath);
    return await withPathLock(lockPath, async () => {
      const recordPath = this.recordPath(key);
      const cached = await readRecord(recordPath);
      if (cached && !isExpired(cached, this.#clock())) {
        return replayOrConflict(cached, key, bodyHash);
      }
      if (cached) await rm(recordPath, { force: true });

      const response = normalizeResponse(await fn());
      const now = this.#clock();
      await writeJsonSecure(recordPath, {
        key,
        bodyHash,
        response,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#ttlSeconds * 1000).toISOString()
      } satisfies CacheRecord);
      return cloneResponse(response);
    });
  }

  private recordPath(key: string): string {
    return join(this.#dir, `${hashKey(key)}.json`);
  }

  private lockPath(key: string): string {
    return join(this.#dir, `${hashKey(key)}.lock`);
  }
}

function replayOrConflict(record: CacheRecord, key: string, bodyHash: string): IdempotencyResponse {
  if (record.bodyHash !== bodyHash) throw new IdempotencyConflict(key);
  return cloneResponse(record.response);
}

async function readRecord(path: string): Promise<CacheRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CacheRecord;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function isExpired(record: CacheRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

function normalizeResponse(response: IdempotencyResponse): IdempotencyResponse {
  if (!Number.isInteger(response.status)) throw new Error("idempotency response status must be an integer");
  return cloneResponse(response);
}

function cloneResponse(response: IdempotencyResponse): IdempotencyResponse {
  return JSON.parse(JSON.stringify(response)) as IdempotencyResponse;
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

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
