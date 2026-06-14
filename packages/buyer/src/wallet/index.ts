import type {
  ApprovalProof,
  BillingAddress,
  CardMetadata,
  Decision,
  PurchaseIntent,
  SimpleCard,
  SimpleLimits,
  SpendReceipt
} from "@steelyard/core";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { BuyerPolicy } from "../policy/index.js";
import { normalizeCurrency, normalizeMerchantDomain } from "../policy/normalize.js";
import {
  BuyerVault,
  fileBoxStore,
  osKeystore,
  passwordKeystore
} from "../vault/index.js";
import { openVaultBox, sealVaultBox } from "../vault/crypto.js";
import { packVaultBox, unpackVaultBox } from "../vault/format.js";
import { parseVaultHeader, type VaultHeader } from "../vault/header.js";
import { isPasswordKeystore, passwordKeystoreWithParams } from "../vault/keystore.js";

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
}

export interface WalletOpenOptions {
  password?: string;
  project?: boolean;
}

export interface PaymentMetadata {
  brand: CardMetadata["brand"];
  last4: string;
  exp: string;
  name: string;
}

interface PaymentVault {
  revealCard(id: string): Promise<{ pan: string; exp: string; name_on_card: string }>;
  recordSpend(receipt: SpendReceipt): Promise<void>;
}

export class WalletNotAllowed extends Error {
  constructor(readonly decision: Decision) {
    super(decision.status === "denied" ? decision.reason : "wallet payment is not allowed");
    this.name = "WalletNotAllowed";
  }
}

export class WalletApprovalRequired extends Error {
  constructor(readonly decision: Extract<Decision, { status: "approval_required" }>) {
    super("wallet payment requires approval");
    this.name = "WalletApprovalRequired";
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

export class Payment {
  readonly metadata: PaymentMetadata;
  readonly billing: { email?: string; address: BillingAddress };
  #vault: PaymentVault;
  #intent: PurchaseIntent;
  #cardId: string;
  #rule?: string;
  #settled = false;

  constructor(opts: {
    vault: PaymentVault;
    intent: PurchaseIntent;
    card: CardMetadata;
    billing: { email?: string; address: BillingAddress };
    rule?: string;
  }) {
    this.#vault = opts.vault;
    this.#intent = opts.intent;
    this.#cardId = opts.card.id;
    this.#rule = opts.rule;
    this.metadata = {
      brand: opts.card.brand,
      last4: opts.card.last4,
      exp: opts.card.exp,
      name: opts.card.name_on_card
    };
    this.billing = { ...opts.billing, address: { ...opts.billing.address } };
  }

  async withRawCard<T>(fn: (card: { number: string; exp: string; name: string }) => Promise<T> | T): Promise<T> {
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
      ts: new Date().toISOString(),
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
  #policy: BuyerPolicy;
  #policyPath: string;
  #vaultPath: string;
  #password?: string;
  #project: boolean;

  private constructor(opts: {
    vault: BuyerVault;
    policy: BuyerPolicy;
    policyPath: string;
    vaultPath: string;
    password?: string;
    project: boolean;
  }) {
    this.#vault = opts.vault;
    this.#policy = opts.policy;
    this.#policyPath = opts.policyPath;
    this.#vaultPath = opts.vaultPath;
    this.#password = opts.password;
    this.#project = opts.project;
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
        project: !!opts.project
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
      project: !!opts.project
    });
  }

  async isAllowed(intent: PurchaseIntent): Promise<boolean> {
    return (await this.decide(intent)).status === "allowed";
  }

  async decide(intent: PurchaseIntent): Promise<Decision> {
    return this.#policy.evaluate(intent, { vault: this.#vault });
  }

  async pay(intent: PurchaseIntent, opts: { approval?: ApprovalProof } = {}): Promise<Payment> {
    const decision = await this.decide(intent);
    if (decision.status === "denied") throw new WalletNotAllowed(decision);
    if (decision.status === "approval_required" && !validApproval(opts.approval)) {
      throw new WalletApprovalRequired(decision);
    }

    const card = await this.#vault.pickCard({ merchant: intent.merchant.domain });
    if (!card) throw new NoCardForMerchant(intent.merchant.domain);
    const billing = await this.#vault.billing();
    return new Payment({
      vault: this.#vault,
      intent,
      card,
      billing: { email: billing.email, address: billing.address },
      rule: decision.status === "allowed" ? decision.rule : decision.matched_rule
    });
  }

  async addCard(card: SimpleCard & { merchants?: string[]; default?: boolean }): Promise<void> {
    const stored = await this.#vault.addCard({
      name_on_card: card.name,
      pan: card.number,
      exp: card.exp,
      tags: [...(card.merchants ?? []).map(normalizeMerchantDomain), ...(card.default ? ["default"] : [])]
    });
    if (card.default) await this.setDefaultCard(stored.id);
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

  async spendInWindow(
    window: "daily" | "weekly" | "monthly",
    currency: string
  ): Promise<{ pending: number; captured: number }> {
    return this.#vault.spendInWindow(window, currency);
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
}

type WalletPolicyObject = {
  version: "0.1";
  default: "deny" | "allow";
  rules: Array<Record<string, unknown>>;
  limits?: Record<string, Record<string, number>>;
};

function walletPaths(project: boolean): { vaultPath: string; policyPath: string } {
  const root = project ? resolve(".steelyard") : join(homedir(), ".steelyard");
  return { vaultPath: join(root, "vault.box"), policyPath: join(root, "policy.yml") };
}

async function loadWalletPolicy(project: boolean): Promise<BuyerPolicy> {
  const paths = project ? [walletPaths(true).policyPath, walletPaths(false).policyPath] : [walletPaths(false).policyPath];
  return BuyerPolicy.load({ paths });
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
  PurchaseIntent,
  SpendReceipt,
  SimpleCard,
  SimpleLimits
};
