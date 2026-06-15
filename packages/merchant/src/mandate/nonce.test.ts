// Copyright (c) Steelyard contributors. MIT License.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileNonceStore, memoryNonceStore } from "./index.js";

describe("memoryNonceStore", () => {
  it("issues expiring nonces and consumes each nonce once", async () => {
    let now = new Date("2026-06-14T12:00:00.000Z");
    const store = memoryNonceStore({ clock: () => now });

    const issued = await store.issue({ session_id: "checkout_1", ttlSeconds: 60 });
    expect(issued.nonce).toEqual(expect.any(String));
    expect(issued.expires_at).toBe("2026-06-14T12:01:00.000Z");

    await expect(store.consume({ nonce: issued.nonce, session_id: "checkout_1" })).resolves.toEqual({ ok: true });
    await expect(store.consume({ nonce: issued.nonce, session_id: "checkout_1" })).resolves.toEqual({
      ok: false,
      reason: "already_consumed"
    });

    now = new Date("2026-06-14T12:02:00.000Z");
    await expect(store.consume({ nonce: issued.nonce, session_id: "checkout_1" })).resolves.toEqual({
      ok: false,
      reason: "expired"
    });
  });

  it("rejects unknown, expired, and wrong-session nonces without consuming valid sessions", async () => {
    let now = new Date("2026-06-14T12:00:00.000Z");
    const store = memoryNonceStore({ ttlSeconds: 1, clock: () => now });

    await expect(store.consume({ nonce: "missing", session_id: "checkout_1" })).resolves.toEqual({
      ok: false,
      reason: "missing"
    });

    const wrongSession = await store.issue({ session_id: "checkout_1" });
    await expect(store.consume({ nonce: wrongSession.nonce, session_id: "checkout_2" })).resolves.toEqual({
      ok: false,
      reason: "session_mismatch"
    });
    await expect(store.consume({ nonce: wrongSession.nonce, session_id: "checkout_1" })).resolves.toEqual({ ok: true });

    const expired = await store.issue({ session_id: "checkout_3" });
    now = new Date("2026-06-14T12:00:02.000Z");
    await expect(store.consume({ nonce: expired.nonce, session_id: "checkout_3" })).resolves.toEqual({
      ok: false,
      reason: "expired"
    });
    await expect(store.consume({ nonce: expired.nonce, session_id: "checkout_3" })).resolves.toEqual({
      ok: false,
      reason: "missing"
    });
  });
});

describe("fileNonceStore", () => {
  it("persists nonces across instances and writes private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-nonce-"));
    try {
      const issued = await fileNonceStore({ dir: root }).issue({ session_id: "checkout_1" });

      await expect(
        fileNonceStore({ dir: root }).consume({ nonce: issued.nonce, session_id: "checkout_1" })
      ).resolves.toEqual({ ok: true });
      await expect(
        fileNonceStore({ dir: root }).consume({ nonce: issued.nonce, session_id: "checkout_1" })
      ).resolves.toEqual({ ok: false, reason: "already_consumed" });

      expect(await fileMode(root)).toBe(0o700);
      const records = await recordFiles(root);
      expect(records).toHaveLength(1);
      await expect(fileMode(join(root, records[0]!))).resolves.toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent consumption so a nonce cannot be replayed", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-nonce-race-"));
    try {
      const issuer = fileNonceStore({ dir: root });
      const issued = await issuer.issue({ session_id: "checkout_1" });
      const a = fileNonceStore({ dir: root });
      const b = fileNonceStore({ dir: root });

      const results = await Promise.all([
        a.consume({ nonce: issued.nonce, session_id: "checkout_1" }),
        b.consume({ nonce: issued.nonce, session_id: "checkout_1" })
      ]);

      expect(results).toContainEqual({ ok: true });
      expect(results).toContainEqual({ ok: false, reason: "already_consumed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves valid nonces after session mismatches and evicts expired records", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-nonce-ttl-"));
    try {
      let now = new Date("2026-06-14T12:00:00.000Z");
      const store = fileNonceStore({ dir: root, ttlSeconds: 1, clock: () => now });
      const wrongSession = await store.issue({ session_id: "checkout_1", ttlSeconds: 60 });

      await expect(store.consume({ nonce: wrongSession.nonce, session_id: "checkout_2" })).resolves.toEqual({
        ok: false,
        reason: "session_mismatch"
      });
      await expect(store.consume({ nonce: wrongSession.nonce, session_id: "checkout_1" })).resolves.toEqual({
        ok: true
      });

      const expired = await store.issue({ session_id: "checkout_3" });
      now = new Date("2026-06-14T12:00:02.000Z");
      await expect(store.consume({ nonce: expired.nonce, session_id: "checkout_3" })).resolves.toEqual({
        ok: false,
        reason: "expired"
      });

      expect(await recordFiles(root)).toHaveLength(1);
      await store.issue({ session_id: "checkout_4" });
      expect(await recordFiles(root)).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function recordFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
}
