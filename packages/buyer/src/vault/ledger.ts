import { systemClock, type PurchaseIntent, type Receipt, type SpendLimits, type SpendReceipt } from "@steelyard/core";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { normalizeCurrency, normalizeMerchantDomain } from "../policy/normalize.js";
import type { VaultHeader } from "./header.js";

export type SpendWindow = "daily" | "weekly" | "monthly";
export type ReservationStatus = "pending" | "pending_escalated";

export interface SpendWindowUsage {
  pending: number;
  captured: number;
}

export interface SpendWindowDetailedUsage extends SpendWindowUsage {
  pending_escalated: number;
}

export interface Reservation {
  id: string;
  intent: PurchaseIntent;
  amount: number;
  currency: string;
  idempotencyKey: string;
  ts: string;
  status: ReservationStatus;
  expires_at?: string;
}

export interface ReserveArgs {
  intent: PurchaseIntent;
  amount?: number;
  currency?: string;
  idempotencyKey: string;
  at: Date;
  limits?: SpendLimits;
}

export class WalletAmountExceeded extends Error {
  readonly requested: number;
  readonly allowed: number;
  readonly currency: string;
  readonly reservation_released: boolean;

  constructor(opts: {
    requested: number;
    allowed: number;
    currency: string;
    reservation_released: boolean;
  }) {
    super(`wallet amount exceeded: requested ${opts.requested} ${opts.currency}, allowed ${opts.allowed}`);
    this.name = "WalletAmountExceeded";
    this.requested = opts.requested;
    this.allowed = opts.allowed;
    this.currency = opts.currency;
    this.reservation_released = opts.reservation_released;
  }
}

export class ResumeExpired extends Error {
  constructor(readonly reservation_id: string, readonly expires_at: string) {
    super(`reservation ${reservation_id} expired at ${expires_at}`);
    this.name = "ResumeExpired";
  }
}

type LedgerEventKind = "reserve" | "adjust" | "release" | "settle";
type LedgerReservationStatus = ReservationStatus | "released" | "captured";

interface LedgerHeader {
  vault_uuid: string;
  schema_version: 2;
  kdf: VaultHeader["kdf"];
  nonce_pool_id: string;
}

interface LedgerRow {
  ts: string;
  kind: LedgerEventKind;
  id: string;
  b64: string;
}

type LedgerEventBody =
  | {
      op: "reserve";
      intent: PurchaseIntent;
      amount: number;
      currency: string;
      idempotency_key: string;
      limits: SpendLimits;
    }
  | { op: "adjust"; amount: number }
  | { op: "mark_escalated"; expires_at: string }
  | { op: "release"; error_summary: string }
  | { op: "settle"; receipt: Receipt; shadow?: boolean }
  | { op: "legacy_spend"; receipt: SpendReceipt };

interface LedgerEvent {
  ts: string;
  kind: LedgerEventKind;
  id: string;
  body: LedgerEventBody;
}

interface ReservationState extends Omit<Reservation, "status"> {
  status: LedgerReservationStatus;
  limits: SpendLimits;
  released_at?: string;
  settled_at?: string;
  receipt?: Receipt;
  shadow_receipt?: Receipt;
  legacy_spend?: SpendReceipt;
}

interface LedgerState {
  reservations: Map<string, ReservationState>;
}

const WINDOW_MS: Record<SpendWindow, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};
const LEDGER_SCHEMA_VERSION = 2;
const NONCE_BYTES = 24;
const ledgerQueues = new Map<string, Promise<void>>();

export class VaultLedger {
  readonly path: string;
  readonly legacyPath: string;
  readonly vaultUuid: string;
  #key: Uint8Array;
  #kdf: VaultHeader["kdf"];

  constructor(opts: {
    path: string;
    legacyPath: string;
    vaultUuid: string;
    key: Uint8Array;
    kdf: VaultHeader["kdf"];
  }) {
    this.path = opts.path;
    this.legacyPath = opts.legacyPath;
    this.vaultUuid = opts.vaultUuid;
    this.#key = opts.key;
    this.#kdf = opts.kdf;
  }

  async migrateLegacyIfNeeded(): Promise<void> {
    if (await exists(this.path)) return;
    if (!(await exists(this.legacyPath))) return;
    const releaseLegacy = await lock(this.legacyPath, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 10, minTimeout: 10, maxTimeout: 100 }
    });
    let migrated = false;
    try {
      if (await exists(this.path)) return;
      const receipts = await readLegacySpendLedger(this.legacyPath);
      await this.withLockedState(async () => {
        const rows = receipts.map((receipt) =>
          this.eventRow({
            ts: receipt.ts,
            kind: "settle",
            id: legacyReservationId(receipt),
            body: { op: "legacy_spend", receipt }
          })
        );
        if (rows.length) await this.appendRows(rows);
      });
      migrated = true;
    } finally {
      try {
        if (migrated) await renameMigratedLegacyLedger(this.legacyPath);
      } finally {
        await releaseLegacy();
      }
    }
  }

  async releaseExpiredEscalations(at: Date): Promise<void> {
    if (!(await exists(this.path))) return;
    await this.withLockedState(async (state) => {
      const rows: LedgerRow[] = [];
      for (const reservation of state.reservations.values()) {
        if (
          reservation.status === "pending_escalated" &&
          reservation.expires_at &&
          new Date(reservation.expires_at).getTime() <= at.getTime()
        ) {
          rows.push(
            this.eventRow({
              ts: at.toISOString(),
              kind: "release",
              id: reservation.id,
              body: { op: "release", error_summary: "resume_expired" }
            })
          );
        }
      }
      if (rows.length) await this.appendRows(rows);
    });
  }

  async recordSpend(receipt: SpendReceipt): Promise<void> {
    const normalized = normalizeSpendReceipt(receipt);
    await this.withLockedState(async () => {
      await this.appendRows([
        this.eventRow({
          ts: normalized.ts,
          kind: "settle",
          id: legacyReservationId(normalized),
          body: { op: "legacy_spend", receipt: normalized }
        })
      ]);
    });
  }

  async listSpend(opts: { since?: Date; until?: Date } = {}): Promise<SpendReceipt[]> {
    const state = await this.readState();
    return [...state.reservations.values()]
      .flatMap((reservation) => {
        if (reservation.legacy_spend) return [reservation.legacy_spend];
        if (reservation.receipt && reservation.status === "captured") {
          return [toSpendReceipt(reservation.receipt)];
        }
        return [];
      })
      .filter((receipt) => withinRange(receipt.ts, opts));
  }

  async listReceipts(opts: { since?: Date; until?: Date } = {}): Promise<Receipt[]> {
    const state = await this.readState();
    return [...state.reservations.values()]
      .flatMap((reservation) =>
        reservation.receipt && reservation.status === "captured" ? [reservation.receipt] : []
      )
      .filter((receipt) => withinRange(receipt.created_at, opts));
  }

  async reserve(args: ReserveArgs): Promise<Reservation> {
    const amount = args.amount ?? args.intent.amount;
    const currency = normalizeCurrency(args.currency ?? args.intent.currency);
    const limits = normalizeLimits(args.limits ?? {});
    const id = randomUUID();
    const ts = args.at.toISOString();
    const intent = normalizeIntent(args.intent);

    return await this.withLockedState(async (state) => {
      assertWithinLimits({
        state,
        amount,
        currency,
        at: args.at,
        limits,
        excludeId: undefined,
        releaseOnFailure: false
      });
      await this.appendRows([
        this.eventRow({
          ts,
          kind: "reserve",
          id,
          body: {
            op: "reserve",
            intent,
            amount,
            currency,
            idempotency_key: args.idempotencyKey,
            limits
          }
        })
      ]);
      return { id, intent, amount, currency, idempotencyKey: args.idempotencyKey, ts, status: "pending" };
    });
  }

  async adjust(id: string, finalTotal: number, at: Date): Promise<void> {
    await this.withLockedState(async (state) => {
      const reservation = activeReservation(state, id);
      if (finalTotal > reservation.amount) {
        await this.appendRows([
          this.releaseRow(id, "amount_exceeded", at),
        ]);
        throw new WalletAmountExceeded({
          requested: finalTotal,
          allowed: reservation.amount,
          currency: reservation.currency,
          reservation_released: true
        });
      }

      try {
        assertWithinLimits({
          state,
          amount: finalTotal,
          currency: reservation.currency,
          at,
          limits: reservation.limits,
          excludeId: id,
          releaseOnFailure: true
        });
      } catch (error) {
        await this.appendRows([this.releaseRow(id, "cap_exceeded", at)]);
        throw error;
      }

      await this.appendRows([
        this.eventRow({
          ts: at.toISOString(),
          kind: "adjust",
          id,
          body: { op: "adjust", amount: finalTotal }
        })
      ]);
    });
  }

  async markEscalated(id: string, expires_at: string, at: Date): Promise<void> {
    await this.withLockedState(async (state) => {
      activeReservation(state, id);
      await this.appendRows([
        this.eventRow({
          ts: at.toISOString(),
          kind: "adjust",
          id,
          body: { op: "mark_escalated", expires_at: new Date(expires_at).toISOString() }
        })
      ]);
    });
  }

  async release(id: string, errorSummary: string, at: Date): Promise<void> {
    await this.withLockedState(async (state) => {
      activeReservation(state, id);
      await this.appendRows([this.releaseRow(id, errorSummary, at)]);
    });
  }

  async settle(id: string, receipt: Receipt, at: Date): Promise<void> {
    await this.withLockedState(async (state) => {
      activeReservation(state, id);
      await this.appendRows([
        this.eventRow({
          ts: at.toISOString(),
          kind: "settle",
          id,
          body: { op: "settle", receipt }
        })
      ]);
    });
  }

  async writeShadowReceipt(id: string, receipt: Receipt, at: Date): Promise<void> {
    await this.withLockedState(async (state) => {
      activeReservation(state, id);
      await this.appendRows([
        this.eventRow({
          ts: at.toISOString(),
          kind: "settle",
          id,
          body: { op: "settle", receipt, shadow: true }
        })
      ]);
    });
  }

  async reattach(id: string, at: Date): Promise<Reservation> {
    return await this.withLockedState(async (state) => {
      const reservation = state.reservations.get(id);
      if (reservation?.status !== "pending_escalated") {
        throw new Error(`pending escalated reservation not found: ${id}`);
      }
      if (reservation.expires_at && new Date(reservation.expires_at).getTime() <= at.getTime()) {
        await this.appendRows([this.releaseRow(id, "resume_expired", at)]);
        throw new ResumeExpired(id, reservation.expires_at);
      }
      return toReservation(reservation);
    });
  }

  async pendingReservations(): Promise<Reservation[]> {
    const state = await this.readState();
    return [...state.reservations.values()]
      .filter((reservation) => reservation.status === "pending" || reservation.status === "pending_escalated")
      .map(toReservation);
  }

  async shadowReceipt(id: string): Promise<Receipt | undefined> {
    const state = await this.readState();
    return state.reservations.get(id)?.shadow_receipt;
  }

  async spendInWindow(window: SpendWindow, currency: string, at = systemClock()): Promise<SpendWindowUsage> {
    const detailed = await this.spendInWindowDetailed(window, currency, at);
    return { pending: detailed.pending, captured: detailed.captured };
  }

  async spendInWindowDetailed(
    window: SpendWindow,
    currency: string,
    at = systemClock()
  ): Promise<SpendWindowDetailedUsage> {
    const state = await this.readState();
    return usageForWindow(state, window, currency, at);
  }

  private async readState(): Promise<LedgerState> {
    if (!(await exists(this.path))) return { reservations: new Map() };
    return replayEvents(await this.readEvents());
  }

  private async withLockedState<T>(fn: (state: LedgerState) => Promise<T>): Promise<T> {
    return await withLedgerQueue(this.path, async () => {
      await this.ensureLedger();
      const release = await lock(this.path, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 10, minTimeout: 10, maxTimeout: 100 }
      });
      try {
        return await fn(replayEvents(await this.readEvents()));
      } finally {
        await release();
      }
    });
  }

  private async ensureLedger(): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmodBestEffort(dir, 0o700);
    try {
      const info = await stat(this.path);
      if (info.size > 0) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeInitialLedger(this.path, {
      vault_uuid: this.vaultUuid,
      schema_version: LEDGER_SCHEMA_VERSION,
      kdf: this.#kdf,
      nonce_pool_id: randomUUID()
    });
  }

  private async readEvents(): Promise<LedgerEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = contents.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [];
    const header = JSON.parse(lines[0]!) as LedgerHeader;
    if (header.schema_version !== LEDGER_SCHEMA_VERSION || header.vault_uuid !== this.vaultUuid) {
      throw new Error("ledger header is unsupported");
    }
    const events: LedgerEvent[] = [];
    for (const [index, line] of lines.slice(1).entries()) {
      try {
        const row = JSON.parse(line) as LedgerRow;
        events.push({ ts: row.ts, kind: row.kind, id: row.id, body: this.openBody(row) });
      } catch (error) {
        process.stderr.write(
          `steelyard/buyer/vault: skipped malformed encrypted ledger line ${index + 2}: ${
            error instanceof Error ? error.message : String(error)
          }\n`
        );
      }
    }
    return events;
  }

  private async appendRows(rows: LedgerRow[]): Promise<void> {
    if (!rows.length) return;
    const handle = await open(this.path, "a", 0o600);
    try {
      for (const row of rows) {
        const line = `${JSON.stringify(row)}\n`;
        await handle.write(Buffer.from(line, "utf8"));
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(this.path, 0o600);
  }

  private eventRow(event: LedgerEvent): LedgerRow {
    return {
      ts: event.ts,
      kind: event.kind,
      id: event.id,
      b64: this.sealBody(event.kind, event.id, event.body)
    };
  }

  private releaseRow(id: string, errorSummary: string, at: Date): LedgerRow {
    return this.eventRow({
      ts: at.toISOString(),
      kind: "release",
      id,
      body: { op: "release", error_summary: errorSummary }
    });
  }

  private sealBody(kind: LedgerEventKind, id: string, body: LedgerEventBody): string {
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
    const aad = rowAad(this.vaultUuid, kind, id);
    const plaintext = new TextEncoder().encode(JSON.stringify({ aad, body }));
    const ciphertext = xsalsa20poly1305(this.#key, nonce).encrypt(plaintext);
    const packed = new Uint8Array(nonce.length + ciphertext.length);
    packed.set(nonce, 0);
    packed.set(ciphertext, nonce.length);
    return Buffer.from(packed).toString("base64");
  }

  private openBody(row: LedgerRow): LedgerEventBody {
    const packed = Buffer.from(row.b64, "base64");
    if (packed.length <= NONCE_BYTES) throw new Error("ledger row ciphertext is malformed");
    const nonce = packed.subarray(0, NONCE_BYTES);
    const ciphertext = packed.subarray(NONCE_BYTES);
    const plaintext = xsalsa20poly1305(this.#key, nonce).decrypt(ciphertext);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as {
      aad?: string;
      body?: LedgerEventBody;
    };
    if (decoded.aad !== rowAad(this.vaultUuid, row.kind, row.id) || !decoded.body) {
      throw new Error("ledger row authentication failed");
    }
    return decoded.body;
  }
}

async function writeInitialLedger(path: string, header: LedgerHeader): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await waitForLedgerHeader(path);
    await chmod(path, 0o600);
    return;
  }

  try {
    await handle.write(Buffer.from(`${JSON.stringify(header)}\n`, "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function waitForLedgerHeader(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const contents = await readFile(path, "utf8");
      if (contents.includes("\n")) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("ledger header was not initialized");
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
  }
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

function replayEvents(events: LedgerEvent[]): LedgerState {
  const reservations = new Map<string, ReservationState>();
  for (const event of events) {
    applyEvent(reservations, event);
  }
  return { reservations };
}

function applyEvent(reservations: Map<string, ReservationState>, event: LedgerEvent): void {
  const body = event.body;
  if (body.op === "reserve") {
    reservations.set(event.id, {
      id: event.id,
      intent: body.intent,
      amount: body.amount,
      currency: body.currency,
      idempotencyKey: body.idempotency_key,
      ts: event.ts,
      status: "pending",
      limits: body.limits
    });
    return;
  }
  if (body.op === "legacy_spend") {
    reservations.set(event.id, legacyState(event.id, body.receipt));
    return;
  }
  const reservation = reservations.get(event.id);
  if (!reservation) return;
  switch (body.op) {
    case "adjust":
      if (reservation.status === "pending" || reservation.status === "pending_escalated") {
        reservation.amount = body.amount;
      }
      break;
    case "mark_escalated":
      if (reservation.status === "pending") {
        reservation.status = "pending_escalated";
        reservation.expires_at = body.expires_at;
      }
      break;
    case "release":
      if (reservation.status === "pending" || reservation.status === "pending_escalated") {
        reservation.status = "released";
        reservation.released_at = event.ts;
      }
      break;
    case "settle":
      if (body.shadow) {
        reservation.shadow_receipt = body.receipt;
      } else if (reservation.status === "pending" || reservation.status === "pending_escalated") {
        reservation.status = "captured";
        reservation.settled_at = event.ts;
        reservation.receipt = body.receipt;
        reservation.amount = body.receipt.charged_amount;
        reservation.currency = normalizeCurrency(body.receipt.charged_currency);
      }
      break;
  }
}

function activeReservation(state: LedgerState, id: string): ReservationState {
  const reservation = state.reservations.get(id);
  if (!reservation || (reservation.status !== "pending" && reservation.status !== "pending_escalated")) {
    throw new Error(`pending reservation not found: ${id}`);
  }
  return reservation;
}

function assertWithinLimits(opts: {
  state: LedgerState;
  amount: number;
  currency: string;
  at: Date;
  limits: SpendLimits;
  excludeId: string | undefined;
  releaseOnFailure: boolean;
}): void {
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const cap = opts.limits[window]?.[opts.currency];
    if (cap === undefined) continue;
    const usage = usageForWindow(opts.state, window, opts.currency, opts.at, opts.excludeId);
    const current = usage.pending + usage.pending_escalated + usage.captured;
    if (current + opts.amount > cap) {
      throw new WalletAmountExceeded({
        requested: opts.amount,
        allowed: Math.max(0, cap - current),
        currency: opts.currency,
        reservation_released: opts.releaseOnFailure
      });
    }
  }
}

function usageForWindow(
  state: LedgerState,
  window: SpendWindow,
  currency: string,
  at: Date,
  excludeId?: string
): SpendWindowDetailedUsage {
  const cutoff = at.getTime() - WINDOW_MS[window];
  const normalizedCurrency = normalizeCurrency(currency);
  const usage: SpendWindowDetailedUsage = { pending: 0, pending_escalated: 0, captured: 0 };
  for (const reservation of state.reservations.values()) {
    if (reservation.id === excludeId) continue;
    if (normalizeCurrency(reservation.currency) !== normalizedCurrency) continue;
    const ts = reservationTimestamp(reservation);
    if (new Date(ts).getTime() < cutoff) continue;
    if (reservation.status === "pending") usage.pending += reservation.amount;
    if (reservation.status === "pending_escalated") usage.pending_escalated += reservation.amount;
    if (reservation.status === "captured") usage.captured += reservation.amount;
  }
  return {
    pending: usage.pending + usage.pending_escalated,
    pending_escalated: usage.pending_escalated,
    captured: usage.captured
  };
}

function reservationTimestamp(reservation: ReservationState): string {
  return reservation.settled_at ?? reservation.ts;
}

async function readLegacySpendLedger(path: string): Promise<SpendReceipt[]> {
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
      receipts.push(normalizeSpendReceipt(JSON.parse(line)));
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

async function renameMigratedLegacyLedger(path: string): Promise<void> {
  const target = `${path}.migrated-${systemClock().toISOString()}`;
  try {
    await rename(path, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function normalizeSpendReceipt(value: unknown): SpendReceipt {
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

function toSpendReceipt(receipt: Receipt): SpendReceipt {
  return {
    ts: receipt.created_at,
    intent_id: receipt.intent.intent_id ?? `<unknown:${receipt.order_id}>`,
    merchant_domain: normalizeMerchantDomain(receipt.intent.merchant.domain),
    amount: receipt.charged_amount,
    currency: normalizeCurrency(receipt.charged_currency),
    status: receipt.status === "completed" || receipt.status === "captured" ? "completed" : "failed"
  };
}

function legacyState(id: string, receipt: SpendReceipt): ReservationState {
  return {
    id,
    intent: {
      merchant: {
        domain: receipt.merchant_domain,
        transport_url: "",
        protocol: "mcp"
      },
      offer: { id: "", title: "", categories: [] },
      amount: receipt.amount,
      currency: receipt.currency,
      intent_id: receipt.intent_id
    },
    amount: receipt.status === "completed" ? receipt.amount : 0,
    currency: receipt.currency,
    idempotencyKey: id,
    ts: receipt.ts,
    status: receipt.status === "completed" ? "captured" : "released",
    limits: {},
    legacy_spend: receipt
  };
}

function normalizeIntent(intent: PurchaseIntent): PurchaseIntent {
  return {
    ...intent,
    merchant: { ...intent.merchant, domain: normalizeMerchantDomain(intent.merchant.domain) },
    currency: normalizeCurrency(intent.currency)
  };
}

function normalizeLimits(limits: SpendLimits): SpendLimits {
  const normalized: SpendLimits = {};
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const entries = Object.entries(limits[window] ?? {});
    if (!entries.length) continue;
    normalized[window] = {};
    for (const [currency, amount] of entries) {
      normalized[window]![normalizeCurrency(currency)] = amount;
    }
  }
  return normalized;
}

function toReservation(reservation: ReservationState): Reservation {
  return {
    id: reservation.id,
    intent: reservation.intent,
    amount: reservation.amount,
    currency: reservation.currency,
    idempotencyKey: reservation.idempotencyKey,
    ts: reservation.ts,
    status: reservation.status as ReservationStatus,
    ...(reservation.expires_at ? { expires_at: reservation.expires_at } : {})
  };
}

function withinRange(ts: string, opts: { since?: Date; until?: Date }): boolean {
  const time = new Date(ts).getTime();
  if (opts.since && time < opts.since.getTime()) return false;
  if (opts.until && time > opts.until.getTime()) return false;
  return true;
}

function rowAad(vaultUuid: string, kind: LedgerEventKind, id: string): string {
  return `${vaultUuid}|${kind}|${id}`;
}

function legacyReservationId(receipt: SpendReceipt): string {
  return `legacy_${createHash("sha256")
    .update(`${receipt.ts}\0${receipt.intent_id}\0${receipt.merchant_domain}\0${receipt.amount}\0${receipt.currency}`)
    .digest("hex")
    .slice(0, 24)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
