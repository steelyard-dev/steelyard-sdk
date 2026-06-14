import type { SpendReceipt } from "@steelyard/core";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuyerVault, memoryBoxStore, memoryKeystore } from "./index.js";

async function withVault<T>(fn: (ctx: { vault: BuyerVault; root: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-ledger-"));
  try {
    const vault = await BuyerVault.init({
      path: join(root, "vault.box"),
      profile: { name: "Ledger User" },
      keystore: memoryKeystore(),
      boxStore: memoryBoxStore()
    });
    return await fn({ vault, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function receipt(overrides: Partial<SpendReceipt> = {}): SpendReceipt {
  return {
    ts: "2026-06-14T12:00:00.000Z",
    intent_id: "intent_1",
    merchant_domain: "shop.example",
    amount: 450,
    currency: "USD",
    status: "completed",
    ...overrides
  };
}

describe("BuyerVault spend ledger", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns empty results for a missing ledger and appends normalized JSONL with strict perms", async () => {
    await withVault(async ({ vault, root }) => {
      await expect(vault.listSpend()).resolves.toEqual([]);
      await expect(vault.spendInWindow("daily", "usd")).resolves.toBe(0);

      await vault.recordSpend(
        receipt({
          merchant_domain: "https://Shop.Example:443/path",
          currency: "usd",
          rule: "coffee under $15"
        })
      );

      const ledgerPath = join(root, "spend-ledger.jsonl");
      const dirMode = (await stat(root)).mode & 0o777;
      const fileMode = (await stat(ledgerPath)).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);

      const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        ts: "2026-06-14T12:00:00.000Z",
        intent_id: "intent_1",
        merchant_domain: "shop.example",
        amount: 450,
        currency: "USD",
        status: "completed",
        rule: "coffee under $15"
      });
    });
  });

  it("sums completed spend inside rolling windows and filters list ranges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T12:00:00.000Z"));

    await withVault(async ({ vault }) => {
      await vault.recordSpend(receipt({ intent_id: "inside_daily", amount: 100, ts: "2026-06-13T12:01:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "outside_daily", amount: 200, ts: "2026-06-13T11:59:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "failed", amount: 300, status: "failed", ts: "2026-06-14T11:00:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "eur", amount: 400, currency: "EUR", ts: "2026-06-14T11:00:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "outside_week", amount: 500, ts: "2026-06-01T12:00:00.000Z" }));

      await expect(vault.spendInWindow("daily", "usd")).resolves.toBe(100);
      await expect(vault.spendInWindow("weekly", "USD")).resolves.toBe(300);
      await expect(vault.spendInWindow("monthly", "USD")).resolves.toBe(800);
      await expect(
        vault.listSpend({
          since: new Date("2026-06-13T11:58:00.000Z"),
          until: new Date("2026-06-14T00:00:00.000Z")
        })
      ).resolves.toMatchObject([{ intent_id: "inside_daily" }, { intent_id: "outside_daily" }]);
    });
  });

  it("skips malformed JSONL rows with a warning", async () => {
    await withVault(async ({ vault }) => {
      await vault.recordSpend(receipt({ intent_id: "valid_before" }));
      await appendFile(vault.ledgerPath, "{not json}\n", { mode: 0o600 });
      await appendFile(vault.ledgerPath, `${JSON.stringify(receipt({ intent_id: "valid_after" }))}\n`);

      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await expect(vault.listSpend()).resolves.toMatchObject([
        { intent_id: "valid_before" },
        { intent_id: "valid_after" }
      ]);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toContain("skipped malformed spend ledger line 2");
    });
  });

  it("preserves concurrent appenders", async () => {
    await withVault(async ({ vault }) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          vault.recordSpend(receipt({ intent_id: `intent_${index}`, amount: index + 1 }))
        )
      );

      const receipts = await vault.listSpend();
      expect(receipts).toHaveLength(20);
      expect(new Set(receipts.map((item) => item.intent_id)).size).toBe(20);
    });
  });

  it("validates receipts and rejects ledger calls after close", async () => {
    await withVault(async ({ vault }) => {
      await expect(vault.recordSpend(receipt({ amount: -1 }))).rejects.toThrow(/amount/);
      await expect(vault.recordSpend(receipt({ rule: "x".repeat(5000) }))).rejects.toThrow(/4 KiB/);

      await vault.close();
      await expect(vault.recordSpend(receipt())).rejects.toThrow(/vault is closed/);
      await expect(vault.spendInWindow("daily", "USD")).rejects.toThrow(/vault is closed/);
      await expect(vault.listSpend()).rejects.toThrow(/vault is closed/);
    });
  });
});
