// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lock } from "proper-lockfile";

export type StoredCheckout = Record<string, unknown> & {
  id: string;
  status: string;
};

export interface StoreFilter {
  ids?: readonly string[];
  status?: string | readonly string[];
  protocol?: "acp" | "ucp";
}

export interface CheckoutSessionStore {
  put(session: StoredCheckout): Promise<void>;
  get(id: string): Promise<StoredCheckout | null>;
  list(filter?: StoreFilter): Promise<StoredCheckout[]>;
  delete(id: string): Promise<void>;
  transition<S extends StoredCheckout>(
    id: string,
    expectedStatus: S["status"],
    nextStatus: S["status"],
    fn: (current: S) => Promise<{ next: S; commit?: () => Promise<void> }>
  ): Promise<S>;
}

export class StoreCasConflict extends Error {
  readonly id: string;
  readonly expectedStatus: string;
  readonly actualStatus: string | null;

  constructor(id: string, expectedStatus: string, actualStatus: string | null) {
    super(
      `checkout session ${id} status conflict: expected ${expectedStatus}, got ${actualStatus ?? "missing"}`
    );
    this.name = "StoreCasConflict";
    this.id = id;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
  }
}

export class StoreNotFound extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`checkout session not found: ${id}`);
    this.name = "StoreNotFound";
    this.id = id;
  }
}

export function memoryCheckoutSessionStore(): CheckoutSessionStore {
  return new MemoryCheckoutSessionStore();
}

export function fileCheckoutSessionStore(opts: { dir: string }): CheckoutSessionStore {
  return new FileCheckoutSessionStore(opts.dir);
}

class MemoryCheckoutSessionStore implements CheckoutSessionStore {
  readonly #rows = new Map<string, StoredCheckout>();
  readonly #queues = new Map<string, Promise<void>>();

  async put(session: StoredCheckout): Promise<void> {
    const normalized = normalizeSession(session);
    await this.withQueue(normalized.id, async () => {
      this.#rows.set(normalized.id, cloneSession(normalized));
    });
  }

  async get(id: string): Promise<StoredCheckout | null> {
    const session = this.#rows.get(id);
    return session ? cloneSession(session) : null;
  }

  async list(filter: StoreFilter = {}): Promise<StoredCheckout[]> {
    return [...this.#rows.values()].filter((session) => matchesFilter(session, filter)).map(cloneSession);
  }

  async delete(id: string): Promise<void> {
    await this.withQueue(id, async () => {
      this.#rows.delete(id);
    });
  }

  async transition<S extends StoredCheckout>(
    id: string,
    expectedStatus: S["status"],
    nextStatus: S["status"],
    fn: (current: S) => Promise<{ next: S; commit?: () => Promise<void> }>
  ): Promise<S> {
    return await this.withQueue(id, async () => {
      const current = this.#rows.get(id);
      if (!current) throw new StoreNotFound(id);
      if (current.status !== expectedStatus) {
        throw new StoreCasConflict(id, String(expectedStatus), current.status);
      }
      const claimed = normalizeSession({ ...current, status: nextStatus });
      this.#rows.set(id, cloneSession(claimed));
      const result = await fn(cloneSession(claimed) as S);
      const next = normalizeSession(result.next);
      this.#rows.set(id, cloneSession(next));
      if (result.commit) await result.commit();
      return cloneSession(next) as S;
    });
  }

  private async withQueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.#queues.set(id, queued);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (this.#queues.get(id) === queued) this.#queues.delete(id);
    }
  }
}

class FileCheckoutSessionStore implements CheckoutSessionStore {
  readonly #dir: string;
  readonly #lockPath: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#lockPath = join(dir, ".sessions.lock");
  }

  async put(session: StoredCheckout): Promise<void> {
    const normalized = normalizeSession(session);
    await this.withStoreLock(async () => {
      await writeJsonSecure(this.sessionPath(normalized.id), normalized);
    });
  }

  async get(id: string): Promise<StoredCheckout | null> {
    return await this.withStoreLock(async () => {
      return await readSession(this.sessionPath(id));
    });
  }

  async list(filter: StoreFilter = {}): Promise<StoredCheckout[]> {
    return await this.withStoreLock(async () => {
      const names = await readdir(this.#dir);
      const rows: StoredCheckout[] = [];
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const session = await readSession(join(this.#dir, name));
        if (session && matchesFilter(session, filter)) rows.push(session);
      }
      return rows;
    });
  }

  async delete(id: string): Promise<void> {
    await this.withStoreLock(async () => {
      await rm(this.sessionPath(id), { force: true });
    });
  }

  async transition<S extends StoredCheckout>(
    id: string,
    expectedStatus: S["status"],
    nextStatus: S["status"],
    fn: (current: S) => Promise<{ next: S; commit?: () => Promise<void> }>
  ): Promise<S> {
    return await this.withStoreLock(async () => {
      const path = this.sessionPath(id);
      const current = await readSession(path);
      if (!current) throw new StoreNotFound(id);
      if (current.status !== expectedStatus) {
        throw new StoreCasConflict(id, String(expectedStatus), current.status);
      }
      const claimed = normalizeSession({ ...current, status: nextStatus });
      await writeJsonSecure(path, claimed);
      const result = await fn(cloneSession(claimed) as S);
      const next = normalizeSession(result.next);
      await writeJsonSecure(path, next);
      if (result.commit) await result.commit();
      return cloneSession(next) as S;
    });
  }

  private sessionPath(id: string): string {
    return join(this.#dir, `${hashKey(id)}.json`);
  }

  private async withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureSecureDir(this.#dir);
    await ensureLockTarget(this.#lockPath);
    return await withPathLock(this.#lockPath, fn);
  }
}

function normalizeSession(session: StoredCheckout): StoredCheckout {
  const cloned = cloneJson(session) as StoredCheckout;
  if (!cloned || typeof cloned.id !== "string" || !cloned.id) {
    throw new Error("checkout session id must be a non-empty string");
  }
  if (typeof cloned.status !== "string" || !cloned.status) {
    throw new Error("checkout session status must be a non-empty string");
  }
  return cloned;
}

function matchesFilter(session: StoredCheckout, filter: StoreFilter): boolean {
  if (filter.ids && !filter.ids.includes(session.id)) return false;
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(session.status)) return false;
  }
  return !filter.protocol || checkoutProtocol(session) === filter.protocol;
}

function checkoutProtocol(session: StoredCheckout): "acp" | "ucp" {
  return "ucp" in session ? "ucp" : "acp";
}

async function readSession(path: string): Promise<StoredCheckout | null> {
  try {
    return normalizeSession(JSON.parse(await readFile(path, "utf8")) as StoredCheckout);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
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

function cloneSession(session: StoredCheckout): StoredCheckout {
  return cloneJson(session) as StoredCheckout;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
