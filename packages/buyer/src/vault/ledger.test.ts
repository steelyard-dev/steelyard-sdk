import type { PurchaseIntent, Receipt, SpendReceipt } from "@steelyard/core";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuyerVault,
  ResumeExpired,
  VaultLedger,
  WalletAmountExceeded,
  memoryBoxStore,
  memoryKeystore
} from "./index.js";

const requireFromTest = createRequire(import.meta.url);
const tsxLoaderUrl = pathToFileURL(requireFromTest.resolve("tsx")).href;

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

function freezeLedgerClock(at = "2026-06-14T12:05:00.000Z"): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
}

const intent: PurchaseIntent = {
  merchant: { domain: "shop.example", transport_url: "https://shop.example/acp", protocol: "acp" },
  offer: { id: "coffee", title: "Coffee", categories: ["coffee"] },
  amount: 500,
  currency: "USD",
  intent_id: "intent_1"
};

function v03Receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    intent,
    protocol: "acp",
    order_id: "order_1",
    status: "completed",
    charged_amount: 450,
    charged_currency: "USD",
    created_at: "2026-06-14T12:02:00.000Z",
    reference: { acp: { checkout_session_id: "checkout_1", vault_token_id: "vt_1" } },
    ...overrides
  };
}

interface ReserveChildResult {
  ok: boolean;
  name?: string;
  message?: string;
}

function reserveChildSource(ledgerModuleUrl: string): string {
  return `
import { VaultLedger } from ${JSON.stringify(ledgerModuleUrl)};

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(\`missing environment variable: \${name}\`);
  return value;
};

try {
  const amount = Number(required("STEELYARD_AMOUNT"));
  const ledger = new VaultLedger({
    path: required("STEELYARD_LEDGER_PATH"),
    legacyPath: required("STEELYARD_LEGACY_LEDGER_PATH"),
    vaultUuid: required("STEELYARD_VAULT_UUID"),
    key: Buffer.from(required("STEELYARD_KEY_HEX"), "hex"),
    kdf: null
  });

  await ledger.reserve({
    intent: {
      merchant: { domain: "shop.example", transport_url: "https://shop.example/acp", protocol: "acp" },
      offer: { id: "race", title: "Race", categories: [] },
      amount,
      currency: "USD",
      intent_id: required("STEELYARD_INTENT_ID")
    },
    amount,
    currency: "USD",
    idempotencyKey: required("STEELYARD_IDEMPOTENCY_KEY"),
    at: new Date("2026-06-14T12:00:00.000Z"),
    limits: { daily: { USD: 1000 } }
  });
  process.send?.({ ok: true });
} catch (error) {
  process.send?.({
    ok: false,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  });
}
`;
}

async function runReserveChild(opts: {
  helperPath: string;
  ledgerPath: string;
  legacyPath: string;
  vaultUuid: string;
  key: Uint8Array;
  intentId: string;
  idempotencyKey: string;
  amount: number;
}): Promise<ReserveChildResult> {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  const child = fork(opts.helperPath, [], {
    execArgv: ["--import", tsxLoaderUrl],
    env: {
      ...env,
      STEELYARD_LEDGER_PATH: opts.ledgerPath,
      STEELYARD_LEGACY_LEDGER_PATH: opts.legacyPath,
      STEELYARD_VAULT_UUID: opts.vaultUuid,
      STEELYARD_KEY_HEX: Buffer.from(opts.key).toString("hex"),
      STEELYARD_INTENT_ID: opts.intentId,
      STEELYARD_IDEMPOTENCY_KEY: opts.idempotencyKey,
      STEELYARD_AMOUNT: String(opts.amount)
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let stderr = "";
  let result: ReserveChildResult | undefined;
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (message) => {
    result = message as ReserveChildResult;
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`reservation child timed out${stderr ? `: ${stderr}` : ""}`));
    }, 10_000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (result) {
        resolve(result);
        return;
      }
      reject(new Error(`reservation child exited without result: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });
}

describe("BuyerVault encrypted spend ledger", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns empty results for a missing ledger and stores v0.2 spend encrypted", async () => {
    await withVault(async ({ vault, root }) => {
      await expect(vault.listSpend()).resolves.toEqual([]);
      await expect(vault.spendInWindow("daily", "usd")).resolves.toEqual({ pending: 0, captured: 0 });

      await vault.recordSpend(
        receipt({
          merchant_domain: "https://Shop.Example:443/path",
          currency: "usd",
          rule: "coffee under $15"
        })
      );

      const dirMode = (await stat(root)).mode & 0o777;
      const fileMode = (await stat(vault.ledgerPath)).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);

      const raw = await readFile(vault.ledgerPath, "utf8");
      expect(raw).toContain('"schema_version":2');
      expect(raw).not.toContain("intent_1");
      expect(raw).not.toContain("shop.example");
      await expect(readFile(vault.legacyLedgerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await expect(vault.listSpend()).resolves.toEqual([
        {
          ts: "2026-06-14T12:00:00.000Z",
          intent_id: "intent_1",
          merchant_domain: "shop.example",
          amount: 450,
          currency: "USD",
          status: "completed",
          rule: "coffee under $15"
        }
      ]);
      await expect(vault.listReceipts()).resolves.toEqual([]);
    });
  });

  it("translates v0.3 receipts back to the exact v0.2 spend key set", async () => {
    await withVault(async ({ vault }) => {
      const reservation = await vault.reserve({
        intent,
        idempotencyKey: "idem_v02_shape",
        at: new Date("2026-06-14T12:00:00.000Z")
      });
      await vault.settleReservation(reservation.id, v03Receipt(), new Date("2026-06-14T12:02:00.000Z"));

      const spend = await vault.listSpend();

      expect(spend).toEqual([
        {
          ts: "2026-06-14T12:02:00.000Z",
          intent_id: "intent_1",
          merchant_domain: "shop.example",
          amount: 450,
          currency: "USD",
          status: "completed"
        }
      ]);
      expect(Object.keys(spend[0]!).sort()).toEqual([
        "amount",
        "currency",
        "intent_id",
        "merchant_domain",
        "status",
        "ts"
      ]);
      expect(spend[0]).not.toHaveProperty("timestamp");
    });
  });

  it("sums pending and captured spend inside rolling windows and filters list ranges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T12:00:00.000Z"));

    await withVault(async ({ vault }) => {
      await vault.recordSpend(receipt({ intent_id: "inside_daily", amount: 100, ts: "2026-06-13T12:01:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "outside_daily", amount: 200, ts: "2026-06-13T11:59:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "failed", amount: 300, status: "failed", ts: "2026-06-14T11:00:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "eur", amount: 400, currency: "EUR", ts: "2026-06-14T11:00:00.000Z" }));
      await vault.recordSpend(receipt({ intent_id: "outside_week", amount: 500, ts: "2026-06-01T12:00:00.000Z" }));
      await vault.reserve({
        intent,
        amount: 50,
        currency: "USD",
        idempotencyKey: "idem_pending",
        at: new Date("2026-06-14T11:30:00.000Z")
      });

      await expect(vault.spendInWindow("daily", "usd")).resolves.toEqual({ pending: 50, captured: 100 });
      await expect(vault.spendInWindow("weekly", "USD")).resolves.toEqual({ pending: 50, captured: 300 });
      await expect(vault.spendInWindow("monthly", "USD")).resolves.toEqual({ pending: 50, captured: 800 });
      await expect(
        vault.listSpend({
          since: new Date("2026-06-13T11:58:00.000Z"),
          until: new Date("2026-06-14T00:00:00.000Z")
        })
      ).resolves.toMatchObject([{ intent_id: "inside_daily" }, { intent_id: "outside_daily" }]);
    });
  });

  it("skips malformed encrypted rows with a warning", async () => {
    await withVault(async ({ vault }) => {
      await vault.recordSpend(receipt({ intent_id: "valid_before" }));
      await vault.recordSpend(receipt({ intent_id: "valid_after" }));
      await appendFile(vault.ledgerPath, "{not json}\n", { mode: 0o600 });

      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await expect(vault.listSpend()).resolves.toMatchObject([
        { intent_id: "valid_before" },
        { intent_id: "valid_after" }
      ]);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toContain("skipped malformed encrypted ledger line 4");
    });
  });

  it("migrates v0.2 plaintext JSONL on open and keeps listReceipts legacy-free", async () => {
    freezeLedgerClock();
    const root = await mkdtemp(join(tmpdir(), "steelyard-ledger-migrate-"));
    try {
      const keystore = memoryKeystore();
      const boxStore = memoryBoxStore();
      const path = join(root, "vault.box");
      const vault = await BuyerVault.init({
        path,
        profile: { name: "Ledger User" },
        keystore,
        boxStore
      });
      await vault.close();
      await writeFile(join(root, "spend-ledger.jsonl"), [
        JSON.stringify(receipt({ amount: 123 })),
        JSON.stringify(receipt({ intent_id: "intent_failed", amount: 50, status: "failed" })),
        "{not json}",
        ""
      ].join("\n"), {
        mode: 0o600
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const reopened = await BuyerVault.open({ path, keystore, boxStore });

      const spend = await reopened.listSpend();
      expect(spend).toEqual([
        receipt({ amount: 123 }),
        receipt({ intent_id: "intent_failed", amount: 50, status: "failed" })
      ]);
      expect(Object.keys(spend[0]!).sort()).toEqual([
        "amount",
        "currency",
        "intent_id",
        "merchant_domain",
        "status",
        "ts"
      ]);
      expect(spend[0]).not.toHaveProperty("timestamp");
      await expect(reopened.listReceipts()).resolves.toEqual([]);
      await expect(reopened.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 123 });
      expect(await readFile(reopened.ledgerPath, "utf8")).toContain('"schema_version":2');
      await expect(readFile(join(root, "spend-ledger.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const migratedFiles = (await readdir(root)).filter((name) => name.startsWith("spend-ledger.jsonl.migrated-"));
      expect(migratedFiles).toHaveLength(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain("skipped malformed spend ledger line 3");

      await reopened.close();
      const reopenedAgain = await BuyerVault.open({ path, keystore, boxStore });
      await expect(reopenedAgain.listSpend()).resolves.toEqual(spend);
      await expect(readdir(root)).resolves.toContain(migratedFiles[0]!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("serializes reservation caps across OS processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-ledger-process-"));
    try {
      const helperPath = join(root, "reserve-child.mjs");
      const ledgerPath = join(root, "ledger.box");
      const legacyPath = join(root, "spend-ledger.jsonl");
      const vaultUuid = "race-vault";
      const key = randomBytes(32);
      await writeFile(helperPath, reserveChildSource(new URL("./ledger.ts", import.meta.url).href));

      const results = await Promise.all([
        runReserveChild({
          helperPath,
          ledgerPath,
          legacyPath,
          vaultUuid,
          key,
          intentId: "intent_race_1",
          idempotencyKey: "idem_race_1",
          amount: 600
        }),
        runReserveChild({
          helperPath,
          ledgerPath,
          legacyPath,
          vaultUuid,
          key,
          intentId: "intent_race_2",
          idempotencyKey: "idem_race_2",
          amount: 600
        })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const failures = results.filter((result) => !result.ok);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ name: "WalletAmountExceeded" });

      const ledger = new VaultLedger({ path: ledgerPath, legacyPath, vaultUuid, key, kdf: null });
      await expect(ledger.spendInWindow("daily", "USD", new Date("2026-06-14T12:01:00.000Z"))).resolves.toEqual({
        pending: 600,
        captured: 0
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves under cap, denies over cap, adjusts, settles, and translates receipts", async () => {
    freezeLedgerClock();
    await withVault(async ({ vault }) => {
      const reservation = await vault.reserve({
        intent,
        idempotencyKey: "idem_1",
        at: new Date("2026-06-14T12:00:00.000Z"),
        limits: { daily: { USD: 1000 } }
      });

      await expect(vault.reserve({
        intent: { ...intent, intent_id: "intent_2" },
        amount: 600,
        currency: "USD",
        idempotencyKey: "idem_2",
        at: new Date("2026-06-14T12:01:00.000Z"),
        limits: { daily: { USD: 1000 } }
      })).rejects.toBeInstanceOf(WalletAmountExceeded);

      await expect(vault.spendInWindowDetailed("daily", "USD")).resolves.toEqual({
        pending: 500,
        pending_escalated: 0,
        captured: 0
      });

      await vault.adjustReservation(reservation.id, 450, new Date("2026-06-14T12:01:00.000Z"));
      await vault.settleReservation(reservation.id, v03Receipt(), new Date("2026-06-14T12:02:00.000Z"));

      await expect(vault.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 450 });
      await expect(vault.listReceipts()).resolves.toMatchObject([{ order_id: "order_1", charged_amount: 450 }]);
      await expect(vault.listSpend()).resolves.toMatchObject([
        { ts: "2026-06-14T12:02:00.000Z", amount: 450, status: "completed" }
      ]);
    });
  });

  it("releases reservations on hard-ceiling and cap-adjust failures", async () => {
    freezeLedgerClock();
    await withVault(async ({ vault }) => {
      const hardCeiling = await vault.reserve({
        intent,
        idempotencyKey: "idem_hard",
        at: new Date("2026-06-14T12:00:00.000Z"),
        limits: { daily: { USD: 1000 } }
      });
      await expect(
        vault.adjustReservation(hardCeiling.id, 501, new Date("2026-06-14T12:01:00.000Z"))
      ).rejects.toMatchObject({ reservation_released: true, allowed: 500 });

      const first = await vault.reserve({
        intent: { ...intent, intent_id: "intent_first" },
        amount: 400,
        idempotencyKey: "idem_first",
        at: new Date("2026-06-14T12:02:00.000Z"),
        limits: { daily: { USD: 700 } }
      });
      const second = await vault.reserve({
        intent: { ...intent, intent_id: "intent_second" },
        amount: 200,
        idempotencyKey: "idem_second",
        at: new Date("2026-06-14T12:03:00.000Z"),
        limits: { daily: { USD: 700 } }
      });

      await expect(
        vault.adjustReservation(second.id, 350, new Date("2026-06-14T12:04:00.000Z"))
      ).rejects.toMatchObject({ reservation_released: true, allowed: 200 });

      await expect(vault.pendingReservations()).resolves.toMatchObject([{ id: first.id }]);
      await expect(vault.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 400, captured: 0 });
    });
  });

  it("releases adjusted reservations when other spend consumes the remaining cap", async () => {
    freezeLedgerClock();
    await withVault(async ({ vault }) => {
      const capped = await vault.reserve({
        intent: { ...intent, intent_id: "intent_capped" },
        amount: 700,
        idempotencyKey: "idem_capped",
        at: new Date("2026-06-14T12:00:00.000Z"),
        limits: { daily: { USD: 1000 } }
      });
      const uncapped = await vault.reserve({
        intent: { ...intent, intent_id: "intent_uncapped" },
        amount: 400,
        idempotencyKey: "idem_uncapped",
        at: new Date("2026-06-14T12:01:00.000Z")
      });

      await expect(
        vault.adjustReservation(capped.id, 700, new Date("2026-06-14T12:02:00.000Z"))
      ).rejects.toMatchObject({ reservation_released: true, allowed: 600 });

      await expect(vault.pendingReservations()).resolves.toMatchObject([{ id: uncapped.id }]);
      await expect(vault.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 400, captured: 0 });
    });
  });

  it("keeps escalated reservations counted until release or resume expiry", async () => {
    freezeLedgerClock();
    await withVault(async ({ vault }) => {
      const reservation = await vault.reserve({
        intent,
        amount: 400,
        idempotencyKey: "idem_escalate",
        at: new Date("2026-06-14T12:00:00.000Z"),
        limits: { daily: { USD: 500 } }
      });
      await vault.markReservationEscalated(
        reservation.id,
        "2026-06-14T12:05:00.000Z",
        new Date("2026-06-14T12:01:00.000Z")
      );

      await expect(vault.spendInWindowDetailed("daily", "USD")).resolves.toEqual({
        pending: 400,
        pending_escalated: 400,
        captured: 0
      });
      await expect(vault.reserve({
        intent: { ...intent, intent_id: "intent_race" },
        amount: 200,
        idempotencyKey: "idem_race",
        at: new Date("2026-06-14T12:02:00.000Z"),
        limits: { daily: { USD: 500 } }
      })).rejects.toBeInstanceOf(WalletAmountExceeded);

      await expect(
        vault.reattachReservation(reservation.id, new Date("2026-06-14T12:06:00.000Z"))
      ).rejects.toBeInstanceOf(ResumeExpired);
      await expect(vault.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 0 });
    });
  });

  it("releases expired escalated reservations when opening a vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-ledger-open-"));
    try {
      const keystore = memoryKeystore();
      const boxStore = memoryBoxStore();
      const path = join(root, "vault.box");
      const vault = await BuyerVault.init({
        path,
        profile: { name: "Ledger User" },
        keystore,
        boxStore
      });
      const reservation = await vault.reserve({
        intent,
        amount: 400,
        idempotencyKey: "idem_expired_open",
        at: new Date("2026-01-01T00:00:00.000Z"),
        limits: { daily: { USD: 500 } }
      });
      await vault.markReservationEscalated(
        reservation.id,
        "2026-01-01T00:05:00.000Z",
        new Date("2026-01-01T00:01:00.000Z")
      );
      await vault.close();

      const reopened = await BuyerVault.open({ path, keystore, boxStore });

      await expect(reopened.pendingReservations()).resolves.toEqual([]);
      await expect(reopened.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores shadow receipts without capturing until settle succeeds", async () => {
    await withVault(async ({ vault }) => {
      const reservation = await vault.reserve({
        intent,
        idempotencyKey: "idem_shadow",
        at: new Date("2026-06-14T12:00:00.000Z")
      });
      const receiptBody = v03Receipt({ order_id: "order_shadow" });

      await vault.writeShadowReceipt(reservation.id, receiptBody, new Date("2026-06-14T12:01:00.000Z"));

      await expect(vault.shadowReceipt(reservation.id)).resolves.toMatchObject({ order_id: "order_shadow" });
      await expect(vault.pendingReservations()).resolves.toMatchObject([{ id: reservation.id }]);
      await expect(vault.listReceipts()).resolves.toEqual([]);

      await vault.settleReservation(reservation.id, receiptBody, new Date("2026-06-14T12:02:00.000Z"));
      await expect(vault.listReceipts()).resolves.toMatchObject([{ order_id: "order_shadow" }]);
    });
  });

  it("validates receipts and rejects ledger calls after close", async () => {
    await withVault(async ({ vault }) => {
      await expect(vault.recordSpend(receipt({ amount: -1 }))).rejects.toThrow(/amount/);

      await vault.close();
      await expect(vault.recordSpend(receipt())).rejects.toThrow(/vault is closed/);
      await expect(vault.spendInWindow("daily", "USD")).rejects.toThrow(/vault is closed/);
      await expect(vault.listSpend()).rejects.toThrow(/vault is closed/);
    });
  });
});
