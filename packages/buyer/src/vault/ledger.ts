import type { SpendReceipt } from "@steelyard/core";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { normalizeCurrency, normalizeMerchantDomain } from "../policy/normalize.js";

export type SpendWindow = "daily" | "weekly" | "monthly";

const WINDOW_MS: Record<SpendWindow, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};
const ledgerQueues = new Map<string, Promise<void>>();

export async function recordSpend(path: string, receipt: SpendReceipt): Promise<void> {
  const normalized = normalizeReceipt(receipt);
  const line = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(line, "utf8") > 4096) {
    throw new Error("spend receipt line exceeds 4 KiB atomic append limit");
  }

  await withLedgerQueue(path, async () => {
    await ensureLedger(path);
    const release = await lock(path, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 10, minTimeout: 10, maxTimeout: 100 }
    });
    try {
      const handle = await open(path, "a", 0o600);
      try {
        const bytes = Buffer.from(line, "utf8");
        await handle.write(bytes, 0, bytes.length);
      } finally {
        await handle.close();
      }
      await chmod(path, 0o600);
    } finally {
      await release();
    }
  });
}

export async function listSpend(
  path: string,
  opts: { since?: Date; until?: Date } = {}
): Promise<SpendReceipt[]> {
  const receipts = await readLedger(path);
  return receipts.filter((receipt) => {
    const ts = new Date(receipt.ts).getTime();
    if (opts.since && ts < opts.since.getTime()) return false;
    if (opts.until && ts > opts.until.getTime()) return false;
    return true;
  });
}

export async function spendInWindow(
  path: string,
  window: SpendWindow,
  currency: string
): Promise<number> {
  const cutoff = Date.now() - WINDOW_MS[window];
  const normalizedCurrency = normalizeCurrency(currency);
  return (await readLedger(path))
    .filter((receipt) => receipt.status === "completed")
    .filter((receipt) => normalizeCurrency(receipt.currency) === normalizedCurrency)
    .filter((receipt) => new Date(receipt.ts).getTime() >= cutoff)
    .reduce((sum, receipt) => sum + receipt.amount, 0);
}

async function ensureLedger(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

async function withLedgerQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = ledgerQueues.get(path) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  ledgerQueues.set(path, queued);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (ledgerQueues.get(path) === queued) ledgerQueues.delete(path);
  }
}

async function readLedger(path: string): Promise<SpendReceipt[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const receipts: SpendReceipt[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      receipts.push(normalizeReceipt(JSON.parse(line)));
    } catch (error) {
      process.stderr.write(
        `steelyard/buyer/vault: skipped malformed spend ledger line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }
  return receipts;
}

function normalizeReceipt(value: unknown): SpendReceipt {
  if (!value || typeof value !== "object") throw new Error("spend receipt must be an object");
  const receipt = value as Partial<SpendReceipt>;
  const ts = receipt.ts;
  const intentId = receipt.intent_id;
  const merchantDomain = receipt.merchant_domain;
  const amount = receipt.amount;
  const currency = receipt.currency;
  const status = receipt.status;
  const rule = receipt.rule;
  if (typeof ts !== "string" || Number.isNaN(new Date(ts).getTime())) {
    throw new Error("spend receipt ts must be ISO 8601");
  }
  if (typeof intentId !== "string" || !intentId.trim()) {
    throw new Error("spend receipt intent_id is required");
  }
  if (typeof merchantDomain !== "string" || !merchantDomain.trim()) {
    throw new Error("spend receipt merchant_domain is required");
  }
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    throw new Error("spend receipt amount must be a non-negative integer");
  }
  if (typeof currency !== "string") {
    throw new Error("spend receipt currency is required");
  }
  if (status !== "completed" && status !== "failed") {
    throw new Error("spend receipt status must be completed or failed");
  }
  if (rule !== undefined && typeof rule !== "string") {
    throw new Error("spend receipt rule must be a string");
  }
  return {
    ts: new Date(ts).toISOString(),
    intent_id: intentId,
    merchant_domain: normalizeMerchantDomain(merchantDomain),
    amount,
    currency: normalizeCurrency(currency),
    status,
    ...(rule ? { rule } : {})
  };
}
