// Copyright (c) Steelyard contributors. MIT License.
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IdempotencyConflict,
  fileIdempotencyStore,
  memoryIdempotencyStore
} from "./index.js";

describe("memoryIdempotencyStore", () => {
  it("single-flights concurrent calls and replays cached responses", async () => {
    const store = memoryIdempotencyStore();
    let calls = 0;

    const [a, b] = await Promise.all([
      store.remember("POST /checkout idem", "hash", async () => {
        calls += 1;
        await delay(25);
        return { status: 201, body: { id: calls } };
      }),
      store.remember("POST /checkout idem", "hash", async () => {
        calls += 1;
        return { status: 500, body: { wrong: true } };
      })
    ]);

    expect(a).toEqual({ status: 201, body: { id: 1 } });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
    await expect(
      store.remember("POST /checkout idem", "hash", async () => ({ status: 202, body: {} }))
    ).resolves.toEqual(a);
  });

  it("rejects same-key body hash conflicts before running work", async () => {
    const store = memoryIdempotencyStore();
    await store.remember("POST /checkout idem", "hash-a", async () => ({ status: 200, body: {} }));

    let calls = 0;
    await expect(
      store.remember("POST /checkout idem", "hash-b", async () => {
        calls += 1;
        return { status: 200, body: {} };
      })
    ).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(calls).toBe(0);
  });

  it("expires cached entries by TTL", async () => {
    let now = new Date("2026-04-17T10:00:00.000Z");
    const store = memoryIdempotencyStore({ ttlSeconds: 1, clock: () => now });
    let calls = 0;

    await store.remember("POST /checkout idem", "hash", async () => {
      calls += 1;
      return { status: 200, body: { calls } };
    });
    now = new Date("2026-04-17T10:00:02.000Z");

    await expect(
      store.remember("POST /checkout idem", "hash", async () => {
        calls += 1;
        return { status: 200, body: { calls } };
      })
    ).resolves.toEqual({ status: 200, body: { calls: 2 } });
  });

  it("rejects malformed responses", async () => {
    const store = memoryIdempotencyStore();

    await expect(
      store.remember("POST /checkout idem", "hash", async () => ({ status: 200.5, body: {} }))
    ).rejects.toThrow(/status must be an integer/);
  });
});

describe("fileIdempotencyStore", () => {
  it("persists replay records, scopes keys by endpoint, and writes private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-idem-"));
    try {
      const store = fileIdempotencyStore({ dir: root });
      const response = await store.remember("POST /a idem", "hash-a", async () => ({
        status: 201,
        body: { ok: true }
      }));

      await expect(
        fileIdempotencyStore({ dir: root }).remember("POST /a idem", "hash-a", async () => ({
          status: 500,
          body: { wrong: true }
        }))
      ).resolves.toEqual(response);
      await expect(
        store.remember("POST /a idem", "hash-b", async () => ({ status: 200, body: {} }))
      ).rejects.toBeInstanceOf(IdempotencyConflict);
      await expect(
        store.remember("POST /b idem", "hash-b", async () => ({ status: 202, body: { scoped: true } }))
      ).resolves.toEqual({ status: 202, body: { scoped: true } });

      expect(await fileMode(root)).toBe(0o700);
      const dataFiles = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
      expect(dataFiles).toHaveLength(2);
      await expect(fileMode(join(root, dataFiles[0]!))).resolves.toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("single-flights same-key work across store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-idem-flight-"));
    try {
      const a = fileIdempotencyStore({ dir: root });
      const b = fileIdempotencyStore({ dir: root });
      let calls = 0;

      const results = await Promise.all([
        a.remember("POST /checkout idem", "hash", async () => {
          calls += 1;
          await delay(25);
          return { status: 201, body: { calls, winner: "a" } };
        }),
        b.remember("POST /checkout idem", "hash", async () => {
          calls += 1;
          return { status: 202, body: { calls, winner: "b" } };
        })
      ]);

      expect(results[0]).toEqual(results[1]);
      expect(calls).toBe(1);
      expect([201, 202]).toContain(results[0].status);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces malformed cache records", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-idem-malformed-"));
    try {
      const store = fileIdempotencyStore({ dir: root });
      await store.remember("POST /checkout idem", "hash", async () => ({ status: 200, body: {} }));
      const dataFile = (await readdir(root)).find((name) => /^[a-f0-9]{64}\.json$/.test(name));
      await writeFile(join(root, dataFile!), "not json\n");

      await expect(
        store.remember("POST /checkout idem", "hash", async () => ({ status: 201, body: {} }))
      ).rejects.toThrow(/Unexpected token/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expires file records by TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-idem-ttl-"));
    try {
      let now = new Date("2026-04-17T10:00:00.000Z");
      const store = fileIdempotencyStore({ dir: root, ttlSeconds: 1, clock: () => now });
      let calls = 0;
      await store.remember("POST /checkout idem", "hash", async () => {
        calls += 1;
        return { status: 200, body: { calls } };
      });
      now = new Date("2026-04-17T10:00:02.000Z");

      await expect(
        store.remember("POST /checkout idem", "hash", async () => {
          calls += 1;
          return { status: 200, body: { calls } };
        })
      ).resolves.toEqual({ status: 200, body: { calls: 2 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
