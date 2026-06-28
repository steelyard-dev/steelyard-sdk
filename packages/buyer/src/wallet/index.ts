import type {
  ApprovalResume,
  ApprovalProof,
  BillingAddress,
  BrowserManualInstrument,
  CardMetadata,
  PaymentMandateIssuer,
  Decision,
  EcJwk,
  HmsAlgorithm,
  JsonWebKey,
  PaymentMandate,
  PaymentInstrument,
  PaymentInstrumentRecord,
  PaymentMandateRequest,
  PaymentMode,
  PurchaseIntent,
  Receipt,
  SimpleCard,
  SimpleLimits,
  SpendReceipt,
  WalletDriverPort
} from "@steelyard/core";
import { newIdempotencyKey, systemClock } from "@steelyard/core";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { WalletRules } from "../policy/index.js";
import { normalizeCurrency, normalizeMerchantDomain } from "../policy/normalize.js";
import {
  BuyerVault,
  MandateKeyMissing,
  ResumeExpired,
  WalletAmountExceeded,
  fileBoxStore,
  osKeystore,
  passwordKeystore,
  type MandateKeyMetadata,
  type Reservation,
  type UcpSigningKeyMetadata
} from "../vault/index.js";
import type { Merchant } from "../client/index.js";
import { openVaultBox, sealVaultBox } from "../vault/crypto.js";
import { packVaultBox, unpackVaultBox } from "../vault/format.js";
import { parseVaultHeader, type VaultHeader } from "../vault/header.js";
import { isPasswordKeystore, passwordKeystoreWithParams } from "../vault/keystore.js";
import {
  REFERENCE_PAYMENT_HANDLER_ID,
  REFERENCE_PAYMENT_INSTRUMENT_TYPE
} from "../reference-payment.js";

export {
  REFERENCE_PAYMENT_HANDLER_ID,
  REFERENCE_PAYMENT_INSTRUMENT_TYPE,
  REFERENCE_PAYMENT_TOKEN_PREFIX,
  ReferencePaymentMandateIssuerError,
  ReferencePaymentMandateIssuerInProductionError,
  createReferencePaymentMandateIssuer,
  referenceMandate
} from "../reference-payment.js";
export type { ReferencePaymentMandateIssuer, ReferencePaymentMandateIssuerOptions } from "../reference-payment.js";

const WALLET_RULE_NAME = "steelyard.wallet.allowed_merchants";
const DEFAULT_POLICY = "deny";

export interface WalletCreateOptions {
  card: SimpleCard;
  billing: { email?: string; address: BillingAddress };
  limits: { daily?: SimpleLimits; weekly?: SimpleLimits; monthly?: SimpleLimits };
  allowedMerchants: string[];
  approvalAbove?: SimpleLimits;
  recovery?: { path: string; password: string };
  password?: string;
  project?: boolean;
  overwrite?: boolean;
  mandateKey?: boolean;
  paymentMandateIssuer?: PaymentMandateIssuer;
}

export interface WalletOpenOptions {
  password?: string;
  project?: boolean;
  paymentMandateIssuer?: PaymentMandateIssuer;
}

export interface PaymentMetadata {
  brand: CardMetadata["brand"];
  last4: string;
  exp: string;
  name: string;
}

interface BrowserManualVault {
  revealCard(id: string): Promise<{ pan: string; exp: string; name_on_card: string }>;
  recordSpend(receipt: SpendReceipt): Promise<void>;
}

export interface BrowserManualSessionOptions {
  approval?: ApprovalProof;
  instrumentId?: string;
}

export interface PurchaseOptions extends BrowserManualSessionOptions {
  merchant: Merchant;
  resume?: ApprovalResume;
  idempotencyKey?: string;
  clock?: () => Date;
}

export interface PrepareMandateOptions {
  instrumentId?: string;
  handlerId?: string;
  transactionId?: string;
  idempotencyKey?: string;
  ttlMs?: number;
  clock?: () => Date;
}

export interface ChooseInstrumentOptions {
  mode?: PaymentMode;
  type?: string;
  instrumentId?: string;
}

export interface VaultedCardOptions extends SimpleCard {
  cvc?: string;
  merchants?: string[];
  default?: boolean;
  label?: string;
}

export function vaultedCard(card: VaultedCardOptions): BrowserManualInstrument {
  const { label, ...storedCard } = card;
  return {
    mode: "browser-manual",
    type: "vaulted_card",
    ...(label ? { label } : {}),
    card: storedCard
  };
}

export class WalletNotAllowed extends Error {
  constructor(readonly decision: Decision) {
    super(decision.status === "denied" ? decision.reason : "wallet payment is not allowed");
    this.name = "WalletNotAllowed";
  }
}

export class WalletApprovalRequired extends Error {
  readonly kind: "policy" | "3ds" | "escalation";
  readonly decision?: Extract<Decision, { status: "approval_required" }>;
  readonly continue_url?: string;
  readonly resume?: ApprovalResume;

  constructor(input: Extract<Decision, { status: "approval_required" }> | {
    kind: "policy" | "3ds" | "escalation";
    decision?: Extract<Decision, { status: "approval_required" }>;
    continue_url?: string;
    resume?: ApprovalResume;
  }) {
    const opts = "status" in input
      ? { kind: "policy" as const, decision: input }
      : input;
    super(opts.kind === "policy" ? "wallet payment requires approval" : `wallet payment requires ${opts.kind} approval`);
    this.name = "WalletApprovalRequired";
    this.kind = opts.kind;
    this.decision = opts.decision;
    this.continue_url = opts.continue_url;
    this.resume = opts.resume;
  }
}

export class ReceiptPersistenceFailed extends Error {
  readonly receipt: Receipt;
  readonly reservation_id: string;
  readonly shadow_persisted: boolean;

  constructor(opts: {
    receipt: Receipt;
    reservation_id: string;
    shadow_persisted: boolean;
    cause: unknown;
  }) {
    super("receipt persistence failed after merchant charge", { cause: opts.cause });
    this.name = "ReceiptPersistenceFailed";
    this.receipt = opts.receipt;
    this.reservation_id = opts.reservation_id;
    this.shadow_persisted = opts.shadow_persisted;
  }
}

export class NoCardForMerchant extends Error {
  constructor(merchant: string) {
    super(`no card for merchant ${merchant}`);
    this.name = "NoCardForMerchant";
  }
}

export class KeystoreUnavailable extends Error {
  constructor(message = "keychain unreachable; pass { password } to use password-derived keystore") {
    super(message);
    this.name = "KeystoreUnavailable";
  }
}

export { MandateKeyMissing, ResumeExpired, WalletAmountExceeded };

export class BrowserManualSession {
  readonly metadata: PaymentMetadata;
  readonly billing: { email?: string; address: BillingAddress };
  #vault: BrowserManualVault;
  #intent: PurchaseIntent;
  #cardId: string;
  #rule?: string;
  #clock: () => Date;
  #settled = false;

  constructor(opts: {
    vault: BrowserManualVault;
    intent: PurchaseIntent;
    card: CardMetadata;
    billing: { email?: string; address: BillingAddress };
    rule?: string;
    clock?: () => Date;
  }) {
    this.#vault = opts.vault;
    this.#intent = opts.intent;
    this.#cardId = opts.card.id;
    this.#rule = opts.rule;
    this.#clock = opts.clock ?? systemClock;
    this.metadata = {
      brand: opts.card.brand,
      last4: opts.card.last4,
      exp: opts.card.exp,
      name: opts.card.name_on_card
    };
    this.billing = { ...opts.billing, address: { ...opts.billing.address } };
  }

  async revealCard<T>(fn: (card: { number: string; exp: string; name: string }) => Promise<T> | T): Promise<T> {
    return this.withRawCard(fn);
  }

  private async withRawCard<T>(fn: (card: { number: string; exp: string; name: string }) => Promise<T> | T): Promise<T> {
    const raw = await this.#vault.revealCard(this.#cardId);
    const released = { number: raw.pan, exp: raw.exp, name: raw.name_on_card };
    try {
      return await fn(released);
    } finally {
      released.number = "0".repeat(raw.pan.length);
      released.exp = "00/00";
      released.name = "";
    }
  }

  async complete(receipt: { status: "completed" | "failed"; ref?: string }): Promise<void> {
    this.claimSettlement();
    await this.#vault.recordSpend({
      ts: this.#clock().toISOString(),
      intent_id: this.#intent.intent_id ?? randomUUID(),
      merchant_domain: normalizeMerchantDomain(this.#intent.merchant.domain),
      amount: this.#intent.amount,
      currency: normalizeCurrency(this.#intent.currency),
      status: receipt.status,
      ...(this.#rule ? { rule: this.#rule } : {})
    });
  }

  async cancel(): Promise<void> {
    this.claimSettlement();
  }

  private claimSettlement(): void {
    if (this.#settled) throw new Error("payment is already settled");
    this.#settled = true;
  }
}

export class Wallet {
  #vault: BuyerVault;
  #policy: WalletRules;
  #policyPath: string;
  #vaultPath: string;
  #password?: string;
  #project: boolean;
  #paymentMandateIssuer?: PaymentMandateIssuer;
  #paymentMandateIssuerRecord?: PaymentInstrumentRecord;

  private constructor(opts: {
    vault: BuyerVault;
    policy: WalletRules;
    policyPath: string;
    vaultPath: string;
    password?: string;
    project: boolean;
    paymentMandateIssuer?: PaymentMandateIssuer;
  }) {
    this.#vault = opts.vault;
    this.#policy = opts.policy;
    this.#policyPath = opts.policyPath;
    this.#vaultPath = opts.vaultPath;
    this.#password = opts.password;
    this.#project = opts.project;
    this.#paymentMandateIssuer = opts.paymentMandateIssuer;
    this.#paymentMandateIssuerRecord = opts.paymentMandateIssuer
      ? mandateInstrumentRecord(opts.paymentMandateIssuer, { default: true })
      : undefined;
  }

  static async create(opts: WalletCreateOptions): Promise<Wallet> {
    const paths = walletPaths(!!opts.project);
    if (!opts.overwrite) {
      await assertMissing(paths.vaultPath, "vault");
      await assertMissing(paths.policyPath, "policy");
    } else {
      await rm(paths.vaultPath, { force: true });
      await rm(paths.policyPath, { force: true });
    }

    const created: string[] = [];
    try {
      await mkdir(dirname(paths.vaultPath), { recursive: true, mode: 0o700 });
      const vault = await BuyerVault.init({
        path: paths.vaultPath,
        profile: { name: opts.card.name, email: opts.billing.email },
        keystore: opts.password ? passwordKeystore({ password: opts.password }) : osKeystore()
      });
      created.push(paths.vaultPath);

      await writePolicy(paths.policyPath, walletPolicyObject({
        limits: opts.limits,
        allowedMerchants: opts.allowedMerchants,
        approvalAbove: opts.approvalAbove
      }), false);
      created.push(paths.policyPath);

      await vault.addCard({
        name_on_card: opts.card.name,
        pan: opts.card.number,
        exp: opts.card.exp,
        tags: ["default"]
      });
      const address = await vault.addAddress(opts.billing.address);
      if (address.id) await vault.setDefaultAddress(address.id);
      if (opts.mandateKey !== false) {
        await vault.createMandateKey();
        await vault.createUcpSigningKey({ algorithm: "ES256" });
      }
      if (opts.recovery) {
        await vault.exportKeyToFile({
          path: expandHome(opts.recovery.path),
          recoveryPassword: opts.recovery.password
        });
      }

      const policy = await loadWalletPolicy(!!opts.project);
      return new Wallet({
        vault,
        policy,
        policyPath: paths.policyPath,
        vaultPath: paths.vaultPath,
        password: opts.password,
        project: !!opts.project,
        paymentMandateIssuer: opts.paymentMandateIssuer
      });
    } catch (error) {
      await Promise.all(created.map((path) => rm(path, { force: true })));
      throw error;
    }
  }

  static async open(opts: WalletOpenOptions = {}): Promise<Wallet> {
    const paths = walletPaths(!!opts.project);
    if (!(await exists(paths.vaultPath))) {
      throw new Error(opts.project
        ? `no project wallet found at ${join(".", ".steelyard", "vault.box")}`
        : `no wallet found at ${paths.vaultPath}. Run Wallet.create() to set one up.`);
    }

    const header = await readVaultHeader(paths.vaultPath);
    const keystore = keystoreForHeader(header, opts.password);
    let vault: BuyerVault;
    try {
      vault = await BuyerVault.open({ path: paths.vaultPath, keystore });
    } catch (error) {
      if (!header.kdf && /OS keychain unavailable|keychain/i.test(error instanceof Error ? error.message : String(error))) {
        throw new KeystoreUnavailable();
      }
      throw error;
    }
    const policy = await loadWalletPolicy(!!opts.project);
    return new Wallet({
      vault,
      policy,
      policyPath: paths.policyPath,
      vaultPath: paths.vaultPath,
      password: opts.password,
      project: !!opts.project,
      paymentMandateIssuer: opts.paymentMandateIssuer
    });
  }

  async isAllowed(intent: PurchaseIntent): Promise<boolean> {
    return (await this.decide(intent)).status === "allowed";
  }

  async decide(intent: PurchaseIntent): Promise<Decision> {
    return this.#policy.evaluate(intent, { vault: this.#vault });
  }

  async purchase(intent: PurchaseIntent, opts: PurchaseOptions): Promise<Receipt> {
    return this.purchaseWithMerchant(intent, opts);
  }

  async createBrowserManualSession(
    intent: PurchaseIntent,
    opts: BrowserManualSessionOptions = {}
  ): Promise<BrowserManualSession> {
    return this.prepareBrowserManualSession(intent, opts);
  }

  async prepareMandate(intent: PurchaseIntent, opts: PrepareMandateOptions = {}): Promise<PaymentMandate> {
    const issuer = this.paymentMandateIssuerFor(opts.instrumentId);
    const clock = opts.clock ?? systemClock;
    const now = clock();
    const nonce = opts.idempotencyKey ?? newIdempotencyKey();
    const handlerId = opts.handlerId ?? defaultHandlerIdForIssuer(issuer);
    const draft: PaymentMandateRequest = {
      iat: Math.floor(now.getTime() / 1000),
      nonce,
      merchant_id: normalizeMerchantDomain(intent.merchant.domain),
      ...(handlerId ? { handler_id: handlerId } : {}),
      instrument_type: issuer.instrumentType,
      transaction_id: opts.transactionId ?? nonce,
      payment: {
        amount: intent.amount,
        currency: normalizeCurrency(intent.currency),
        checkout_id: intent.intent_id ?? nonce,
        expires_at: new Date(now.getTime() + (opts.ttlMs ?? 5 * 60 * 1000)).toISOString()
      }
    };
    return issuer.issueMandate(draft);
  }

  async chooseInstrument(
    _intent: PurchaseIntent,
    opts: ChooseInstrumentOptions = {}
  ): Promise<PaymentInstrumentRecord> {
    const instruments = await this.listInstruments();
    const filtered = instruments.filter((instrument) => {
      if (opts.instrumentId && instrument.id !== opts.instrumentId) return false;
      if (opts.mode && instrument.mode !== opts.mode) return false;
      if (opts.type && instrument.type !== opts.type) return false;
      return true;
    });
    const choice = filtered.find((instrument) => instrument.default) ?? filtered[0];
    if (!choice) throw new Error("no matching payment instrument");
    return { ...choice };
  }

  async ensureUcpSigningKey(opts: { algorithm?: HmsAlgorithm } = {}): Promise<UcpSigningKeyMetadata> {
    if (await this.#vault.hasUcpSigningKey()) {
      const jwk = await this.#vault.exportUcpSigningPublicKey();
      if (!jwk.kid) throw new Error("UCP signing key is missing a kid");
      return { kid: jwk.kid };
    }
    return this.#vault.createUcpSigningKey({ algorithm: opts.algorithm ?? "ES256" });
  }

  private async prepareBrowserManualSession(
    intent: PurchaseIntent,
    opts: BrowserManualSessionOptions = {}
  ): Promise<BrowserManualSession> {
    const decision = await this.decide(intent);
    if (decision.status === "denied") throw new WalletNotAllowed(decision);
    if (decision.status === "approval_required" && !validApproval(opts.approval)) {
      throw new WalletApprovalRequired(decision);
    }

    const card = await this.cardForIntent(intent, opts.instrumentId);
    if (!card) throw new NoCardForMerchant(intent.merchant.domain);
    const billing = await this.#vault.billing();
    return new BrowserManualSession({
      vault: this.#vault,
      intent,
      card,
      billing: { email: billing.email, address: billing.address },
      rule: decision.status === "allowed" ? decision.rule : decision.matched_rule,
      clock: systemClock
    });
  }

  private async purchaseWithMerchant(intent: PurchaseIntent, opts: PurchaseOptions): Promise<Receipt> {
    const clock = opts.clock ?? systemClock;
    const decision = await this.decide(intent);
    if (decision.status === "denied") throw new WalletNotAllowed(decision);
    if (decision.status === "approval_required" && !validApproval(opts.approval) && !opts.resume) {
      throw new WalletApprovalRequired(decision);
    }

    const idempotencyKey = opts.idempotencyKey ?? opts.resume?.idempotency_key ?? newIdempotencyKey();
    const reservation = opts.resume
      ? await this.#vault.reattachReservation(opts.resume.reservation_id, clock())
      : await this.#vault.reserve({
        intent,
        idempotencyKey,
        amount: intent.amount,
        at: clock(),
        limits: this.#policy.limits
      });

    let receipt: Receipt;
    try {
      const port = await this.buildDriverPort(intent, { instrumentId: opts.instrumentId });
      receipt = await opts.merchant.purchase(intent, {
        port,
        approval: opts.approval,
        resume: opts.resume,
        idempotencyKey,
        reservation_id: reservation.id,
        clock,
        onTotalsKnown: async (finalTotal, currency) => {
          const normalizedCurrency = normalizeCurrency(currency);
          if (normalizedCurrency !== reservation.currency) {
            await this.#vault.releaseReservation(reservation.id, "currency_mismatch", clock());
            throw new WalletAmountExceeded({
              requested: finalTotal,
              allowed: 0,
              currency: normalizedCurrency,
              reservation_released: true
            });
          }
          await this.#vault.adjustReservation(reservation.id, finalTotal, clock());
        }
      });
    } catch (error) {
      if (isResumableApprovalError(error)) {
        await this.#vault.markReservationEscalated(reservation.id, error.resume.expires_at, clock());
        throw error;
      }
      if (!(error instanceof WalletAmountExceeded && error.reservation_released)) {
        await this.#vault.releaseReservation(reservation.id, errorSummary(error), clock());
      }
      throw error;
    }

    try {
      await this.#vault.settleReservation(reservation.id, receipt, clock());
    } catch (settleErr) {
      let shadowErr: Error | undefined;
      try {
        await this.#vault.writeShadowReceipt(reservation.id, receipt, clock());
      } catch (error) {
        shadowErr = error as Error;
      }
      throw new ReceiptPersistenceFailed({
        receipt,
        reservation_id: reservation.id,
        shadow_persisted: shadowErr === undefined,
        cause: shadowErr
          ? new AggregateError([settleErr as Error, shadowErr], "settle and shadow write both failed")
          : settleErr
      });
    }

    return receipt;
  }

  async addInstrument(instrument: PaymentInstrument): Promise<PaymentInstrumentRecord> {
    if (instrument.mode === "agent-native") {
      const record = mandateInstrumentRecord(instrument.issuer, {
        label: instrument.label,
        default: true
      });
      this.#paymentMandateIssuer = instrument.issuer;
      this.#paymentMandateIssuerRecord = record;
      return { ...record };
    }

    const stored = await this.#vault.addCard({
      name_on_card: instrument.card.name,
      pan: instrument.card.number,
      exp: instrument.card.exp,
      tags: [
        ...(instrument.card.merchants ?? []).map(normalizeMerchantDomain),
        ...(instrument.card.default ? ["default"] : [])
      ]
    });
    if (instrument.card.default) await this.setDefaultCard(stored.id);
    return cardInstrumentRecord(stored, {
      label: instrument.label,
      agentNativeDefault: this.#paymentMandateIssuerRecord?.default === true
    });
  }

  async listInstruments(): Promise<PaymentInstrumentRecord[]> {
    const cards = await this.#vault.listCards();
    const agentNativeDefault = this.#paymentMandateIssuerRecord?.default === true;
    return [
      ...(this.#paymentMandateIssuerRecord ? [{ ...this.#paymentMandateIssuerRecord }] : []),
      ...cards.map((card) => cardInstrumentRecord(card, { agentNativeDefault }))
    ];
  }

  async removeInstrument(id: string): Promise<void> {
    if (this.#paymentMandateIssuerRecord?.id === id) {
      this.#paymentMandateIssuer = undefined;
      this.#paymentMandateIssuerRecord = undefined;
      return;
    }
    await this.#vault.removeCard(id);
  }

  async setDefaultInstrument(id: string): Promise<void> {
    if (this.#paymentMandateIssuerRecord?.id === id) {
      this.#paymentMandateIssuerRecord = { ...this.#paymentMandateIssuerRecord, default: true };
      return;
    }
    if (this.#paymentMandateIssuerRecord) this.#paymentMandateIssuerRecord = { ...this.#paymentMandateIssuerRecord, default: false };
    await this.setDefaultCard(id);
  }

  async addCard(card: SimpleCard & { merchants?: string[]; default?: boolean }): Promise<void> {
    await this.addInstrument(vaultedCard(card));
  }

  async removeCard(id: string): Promise<void> {
    await this.#vault.removeCard(id);
  }

  async listCards(): Promise<CardMetadata[]> {
    return this.#vault.listCards();
  }

  async setDefaultCard(id: string): Promise<void> {
    const cards = await Promise.all((await this.#vault.listCards()).map(async (card) => ({
      metadata: card,
      raw: await this.#vault.revealCard(card.id)
    })));
    if (!cards.some((card) => card.metadata.id === id)) throw new Error(`card not found: ${id}`);
    for (const card of cards) await this.#vault.removeCard(card.metadata.id);
    for (const card of cards) {
      await this.#vault.addCard({
        id: card.metadata.id,
        name_on_card: card.raw.name_on_card,
        pan: card.raw.pan,
        exp: card.raw.exp,
        tags: nextDefaultTags(card.metadata.tags, card.metadata.id === id)
      });
    }
  }

  async setLimits(limits: { daily?: SimpleLimits; weekly?: SimpleLimits; monthly?: SimpleLimits } | SimpleLimits): Promise<void> {
    const normalized = "daily" in limits || "weekly" in limits || "monthly" in limits
      ? limits as { daily?: SimpleLimits; weekly?: SimpleLimits; monthly?: SimpleLimits }
      : { daily: limits as SimpleLimits };
    await updateWalletPolicy(this.#policyPath, (policy) => {
      policy.limits = convertLimitWindows(normalized);
    });
    await this.reloadPolicy();
  }

  async setAllowedMerchants(merchants: string[]): Promise<void> {
    await updateWalletRule(this.#policyPath, (rule) => {
      rule.where = { ...(rule.where ?? {}), merchant_domain: merchants };
    });
    await this.reloadPolicy();
  }

  async setApprovalAbove(threshold: SimpleLimits): Promise<void> {
    await updateWalletRule(this.#policyPath, (rule) => {
      const entries = Object.entries(threshold).filter((entry): entry is [string, number] => typeof entry[1] === "number");
      if (!entries.length) {
        delete rule.requires_approval_above;
        return;
      }
      const [currency, amount] = entries[0]!;
      rule.requires_approval_above = { amount: majorToMinor(currency, amount), currency: normalizeCurrency(currency) };
    });
    await this.reloadPolicy();
  }

  async updateBilling(billing: Partial<{ email: string; address: BillingAddress }>): Promise<void> {
    const current = await this.#vault.billing().catch(() => undefined);
    if (billing.address) {
      if (current?.address.id) await this.#vault.removeAddress(current.address.id);
      const next = await this.#vault.addAddress(billing.address);
      if (next.id) await this.#vault.setDefaultAddress(next.id);
    }
  }

  async listSpend(opts: { since?: Date; until?: Date } = {}): Promise<SpendReceipt[]> {
    return this.#vault.listSpend(opts);
  }

  async listReceipts(opts: { since?: Date; until?: Date } = {}): Promise<Receipt[]> {
    return this.#vault.listReceipts(opts);
  }

  async pendingReservations(): Promise<Reservation[]> {
    return this.#vault.pendingReservations();
  }

  async reconcile(
    reservationId: string,
    opts: { decision: "complete" | "release"; receipt?: Receipt; clock?: () => Date }
  ): Promise<void> {
    const at = (opts.clock ?? systemClock)();
    if (opts.decision === "release") {
      await this.#vault.releaseReservation(reservationId, "reconciled_release", at);
      return;
    }
    const receipt = opts.receipt ?? await this.#vault.shadowReceipt(reservationId);
    if (!receipt) throw new Error(`receipt required to reconcile reservation ${reservationId}`);
    await this.#vault.settleReservation(reservationId, receipt, at);
  }

  async spendInWindow(
    window: "daily" | "weekly" | "monthly",
    currency: string
  ): Promise<{ pending: number; captured: number }> {
    return this.#vault.spendInWindow(window, currency);
  }

  async createMandateKey(): Promise<MandateKeyMetadata> {
    return this.#vault.createMandateKey();
  }

  async hasMandateKey(): Promise<boolean> {
    return this.#vault.hasMandateKey();
  }

  async exportMandatePublicKey(): Promise<{ jwk: JsonWebKey; key_id: string }> {
    return this.#vault.exportMandatePublicKey();
  }

  async createUcpSigningKey(opts: { algorithm: HmsAlgorithm }): Promise<UcpSigningKeyMetadata> {
    return this.#vault.createUcpSigningKey(opts);
  }

  async hasUcpSigningKey(): Promise<boolean> {
    return this.#vault.hasUcpSigningKey();
  }

  async exportUcpSigningPublicKey(): Promise<EcJwk> {
    return this.#vault.exportUcpSigningPublicKey();
  }

  async exportRecovery(opts: { path: string; password: string }): Promise<string> {
    return this.#vault.exportKeyToFile({ path: expandHome(opts.path), recoveryPassword: opts.password });
  }

  async rotatePassword(opts: { oldPassword: string; newPassword: string }): Promise<void> {
    await rotatePasswordVault(this.#vaultPath, opts.oldPassword, opts.newPassword);
    this.#vault = await BuyerVault.open({
      path: this.#vaultPath,
      keystore: passwordKeystore({ password: opts.newPassword })
    });
    this.#password = opts.newPassword;
  }

  async close(): Promise<void> {
    await this.#vault.close();
  }

  private async reloadPolicy(): Promise<void> {
    this.#policy = await loadWalletPolicy(this.#project);
  }

  private paymentMandateIssuerFor(instrumentId?: string): PaymentMandateIssuer {
    if (!this.#paymentMandateIssuer || !this.#paymentMandateIssuerRecord) {
      throw new Error("no agent-native payment instrument configured");
    }
    if (instrumentId && instrumentId !== this.#paymentMandateIssuerRecord.id) {
      throw new Error(`agent-native payment instrument not found: ${instrumentId}`);
    }
    return this.#paymentMandateIssuer;
  }

  private async cardForIntent(intent: PurchaseIntent, instrumentId?: string): Promise<CardMetadata | null> {
    if (!instrumentId || this.#paymentMandateIssuerRecord?.id === instrumentId) {
      return this.#vault.pickCard({ merchant: intent.merchant.domain });
    }
    return (await this.#vault.listCards()).find((card) => card.id === instrumentId) ?? null;
  }

  private async buildDriverPort(
    intent: PurchaseIntent,
    opts: { instrumentId?: string } = {}
  ): Promise<WalletDriverPort> {
    const card = await this.cardForIntent(intent, opts.instrumentId);
    if (!card) throw new NoCardForMerchant(intent.merchant.domain);
    const billing = await this.#vault.billing();
    return {
      billing,
      ...(this.#paymentMandateIssuer ? { paymentMandateIssuer: this.#paymentMandateIssuer } : {}),
      withRawCard: async (fn) => {
        const raw = await this.#vault.revealCard(card.id);
        const released = { ...raw };
        try {
          return await fn(released);
        } finally {
          released.pan = "0".repeat(raw.pan.length);
          released.name_on_card = "";
          released.exp = "00/00";
        }
      },
      signMandate: (payload) => this.#vault.signMandate(payload),
      pairwiseSubject: (audience) => this.#vault.pairwiseSubject(audience),
      mandatePublicKey: () => this.#vault.mandatePublicKey(),
      createUcpSigningKey: (keyOpts) => this.#vault.createUcpSigningKey(keyOpts),
      hasUcpSigningKey: () => this.#vault.hasUcpSigningKey(),
      exportUcpSigningPublicKey: () => this.#vault.exportUcpSigningPublicKey(),
      signWithUcpKey: (args) => this.#vault.signWithUcpKey(args)
    };
  }
}

type WalletPolicyObject = {
  version: "0.1";
  default: "deny" | "allow";
  rules: Array<Record<string, unknown>>;
  limits?: Record<string, Record<string, number>>;
};

function mandateInstrumentRecord(
  issuer: PaymentMandateIssuer,
  opts: { label?: string; default?: boolean } = {}
): PaymentInstrumentRecord {
  return {
    id: `agent-native_${instrumentIdPart(issuer.instrumentType)}`,
    mode: "agent-native",
    type: issuer.instrumentType,
    label: opts.label ?? readableInstrumentLabel(issuer.instrumentType),
    created_at: systemClock().toISOString(),
    ...(opts.default !== undefined ? { default: opts.default } : {})
  };
}

function cardInstrumentRecord(
  card: CardMetadata,
  opts: { label?: string; agentNativeDefault?: boolean } = {}
): PaymentInstrumentRecord {
  return {
    id: card.id,
    mode: "browser-manual",
    type: "vaulted_card",
    label: opts.label ?? `${card.brand} ****${card.last4}`,
    created_at: systemClock().toISOString(),
    default: !opts.agentNativeDefault && card.tags.includes("default")
  };
}

function defaultHandlerIdForIssuer(issuer: PaymentMandateIssuer): string | undefined {
  if (issuer.instrumentType === REFERENCE_PAYMENT_INSTRUMENT_TYPE) return REFERENCE_PAYMENT_HANDLER_ID;
  return undefined;
}

function readableInstrumentLabel(type: string): string {
  return type
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function instrumentIdPart(type: string): string {
  return type.replace(/[^A-Za-z0-9_-]+/g, "_");
}

function walletPaths(project: boolean): { vaultPath: string; policyPath: string } {
  const root = project ? resolve(".steelyard") : join(homedir(), ".steelyard");
  return { vaultPath: join(root, "vault.box"), policyPath: join(root, "policy.yml") };
}

async function loadWalletPolicy(project: boolean): Promise<WalletRules> {
  const paths = project ? [walletPaths(true).policyPath, walletPaths(false).policyPath] : [walletPaths(false).policyPath];
  return WalletRules.load({ paths });
}

function keystoreForHeader(header: VaultHeader, password: string | undefined) {
  if (header.kdf) {
    if (!password) throw new Error("password required for password-derived vault");
    return passwordKeystore({ password });
  }
  return osKeystore();
}

async function readVaultHeader(path: string): Promise<VaultHeader> {
  return parseVaultHeader(unpackVaultBox(new Uint8Array(await readFile(path))).header);
}

function walletPolicyObject(opts: {
  limits: { daily?: SimpleLimits; weekly?: SimpleLimits; monthly?: SimpleLimits };
  allowedMerchants: string[];
  approvalAbove?: SimpleLimits;
}): WalletPolicyObject {
  const rule: Record<string, unknown> = {
    name: WALLET_RULE_NAME,
    can: "buy",
    where: { merchant_domain: opts.allowedMerchants }
  };
  const approval = approvalFromLimits(opts.approvalAbove);
  if (approval) rule.requires_approval_above = approval;
  return {
    version: "0.1",
    default: DEFAULT_POLICY,
    rules: [rule],
    limits: convertLimitWindows(opts.limits)
  };
}

function approvalFromLimits(limits: SimpleLimits | undefined): { amount: number; currency: string } | undefined {
  const entry = Object.entries(limits ?? {}).find((item): item is [string, number] => typeof item[1] === "number");
  return entry ? { currency: normalizeCurrency(entry[0]), amount: majorToMinor(entry[0], entry[1]) } : undefined;
}

function convertLimitWindows(limits: { daily?: SimpleLimits; weekly?: SimpleLimits; monthly?: SimpleLimits }): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const converted = convertSimpleLimits(limits[window] ?? {});
    if (Object.keys(converted).length) out[window] = converted;
  }
  return out;
}

function convertSimpleLimits(limits: SimpleLimits): Record<string, number> {
  return Object.fromEntries(
    Object.entries(limits)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .map(([currency, amount]) => [normalizeCurrency(currency), majorToMinor(currency, amount)])
  );
}

function majorToMinor(currency: string, amount: number): number {
  const exponent = currencyExponent(normalizeCurrency(currency));
  return Math.round(amount * 10 ** exponent);
}

function currencyExponent(currency: string): number {
  if (["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"].includes(currency)) return 0;
  if (["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(currency)) return 3;
  return 2;
}

async function writePolicy(path: string, policy: WalletPolicyObject, overwrite: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, stringifyPolicy(policy), { mode: 0o600, flag: overwrite ? "w" : "wx" });
}

function stringifyPolicy(policy: WalletPolicyObject): string {
  return stringify(policy);
}

async function updateWalletPolicy(path: string, update: (policy: WalletPolicyObject) => void): Promise<void> {
  const doc = parseDocument(await readFile(path, "utf8"));
  const policy = doc.toJSON() as WalletPolicyObject;
  update(policy);
  await writePolicy(path, policy, true);
}

async function updateWalletRule(path: string, update: (rule: Record<string, any>) => void): Promise<void> {
  await updateWalletPolicy(path, (policy) => {
    const rules = Array.isArray(policy.rules) ? policy.rules : [];
    const rule = rules.find((candidate) => candidate.name === WALLET_RULE_NAME);
    if (!rule) throw new Error("wallet-owned policy section was removed; cannot update via Wallet — edit YAML directly");
    update(rule as Record<string, any>);
    policy.rules = rules;
  });
}

function nextDefaultTags(tags: string[], makeDefault: boolean): string[] {
  const withoutDefault = tags.filter((tag) => tag !== "default");
  return makeDefault ? [...withoutDefault, "default"] : withoutDefault;
}

async function rotatePasswordVault(path: string, oldPassword: string, newPassword: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(path));
  const packed = unpackVaultBox(bytes);
  const header = parseVaultHeader(packed.header);
  if (!header.kdf) throw new Error("rotatePassword is only available for password-mode vaults");

  const oldStore = passwordKeystore({ password: oldPassword });
  if (!isPasswordKeystore(oldStore)) throw new Error("password keystore required");
  const oldKey = await oldStore.deriveMasterKey(header.kdf);
  const plaintext = openVaultBox({ key: oldKey, header, nonce: packed.nonce, ciphertext: packed.ciphertext });
  oldKey.fill(0);

  const newStore = passwordKeystoreWithParams({ password: newPassword, iterations: 3, memory_kib: 65_536, parallelism: 4 });
  if (!isPasswordKeystore(newStore)) throw new Error("password keystore required");
  const { key: newKey, kdf } = await newStore.createMasterKey();
  const nextHeader = { ...header, kdf };
  const sealed = sealVaultBox({ key: newKey, header: nextHeader, plaintext });
  newKey.fill(0);
  await fileBoxStore(dirname(path)).write("vault.box", packVaultBox(sealed));
}

function validApproval(approval: ApprovalProof | undefined): boolean {
  return !!approval && typeof approval.source === "string" && !Number.isNaN(new Date(approval.ts).getTime());
}

function isResumableApprovalError(error: unknown): error is WalletApprovalRequired & { resume: ApprovalResume } {
  return error instanceof WalletApprovalRequired && error.kind !== "policy" && !!error.resume;
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 240);
  return String(error).slice(0, 240);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertMissing(path: string, label: string): Promise<void> {
  if (await exists(path)) throw new Error(`${label} file already exists at ${path}`);
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

export type {
  ApprovalProof,
  BillingAddress,
  CardMetadata,
  Decision,
  BrowserManualInstrument,
  PaymentMandateIssuer,
  PaymentMandate,
  PaymentInstrument,
  PaymentInstrumentRecord,
  PaymentMode,
  PurchaseIntent,
  SpendReceipt,
  SimpleCard,
  SimpleLimits
};
