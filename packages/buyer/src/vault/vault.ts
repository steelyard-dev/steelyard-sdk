import {
  systemClock,
  type BillingAddress,
  type BillingPayload,
  type CardMetadata,
  type EcJwk,
  type HmsAlgorithm,
  type JsonWebKey,
  type Receipt,
  type SpendReceipt
} from "@steelyard/core";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, basename, resolve, join } from "node:path";
import {
  createStoredAddress,
  publicAddress,
  type NewAddress,
  type StoredAddress
} from "./address.js";
import { fileBoxStore, type BoxStore } from "./boxstore.js";
import {
  cardMetadata,
  createStoredCard,
  pickStoredCard,
  rawCard,
  type NewCard,
  type RawCard,
  type StoredCard
} from "./card.js";
import { openVaultBox, sealVaultBox, VAULT_KEY_BYTES } from "./crypto.js";
import { packVaultBox, unpackVaultBox } from "./format.js";
import { createVaultHeader, parseVaultHeader, type VaultHeader } from "./header.js";
import {
  VAULT_KEY_SERVICE,
  isPasswordKeystore,
  osKeystore,
  type Keystore
} from "./keystore.js";
import {
  VaultLedger,
  type Reservation,
  type ReserveArgs,
  type SpendWindowDetailedUsage,
  type SpendWindowUsage,
  type SpendWindow
} from "./ledger.js";
import {
  MandateKeyMissing,
  createStoredMandateKey,
  mandateKeyMetadata,
  mandatePublicKey,
  normalizeStoredMandateKey,
  pairwiseSubject as derivePairwiseSubject,
  signMandateJwt,
  type MandateKeyMetadata,
  type StoredMandateKey
} from "./mandate.js";
import {
  UcpSigningKeyMissing,
  createStoredUcpSigningKey,
  normalizeStoredUcpSigningKey,
  signWithUcpKey as signWithStoredUcpKey,
  ucpSigningKeyMetadata,
  ucpSigningPublicKey,
  type StoredUcpSigningKey,
  type UcpSigningKeyMetadata
} from "./ucp-signing.js";
import {
  exportKeyToRecoveryFile,
  exportKeyUnsafe,
  importKeyFromRecoveryFile
} from "./recovery.js";

export interface VaultInitOptions {
  profile: { name: string; email?: string };
  path?: string;
  keystore?: Keystore;
  boxStore?: BoxStore;
}

export interface VaultOpenOptions {
  path: string;
  keystore?: Keystore;
  boxStore?: BoxStore;
}

interface VaultRecord {
  profile: { name: string; email?: string };
  cards: StoredCard[];
  addresses: StoredAddress[];
  mandateKey?: StoredMandateKey;
  ucpSigningKey?: StoredUcpSigningKey;
}

export class BuyerVault {
  readonly path: string;
  readonly ledgerPath: string;
  readonly legacyLedgerPath: string;
  readonly ledger: VaultLedger;
  readonly uuid: string;
  #profile: { name: string; email?: string };
  #header: VaultHeader;
  #boxStore: BoxStore;
  #boxName: string;
  #masterKey: Uint8Array;
  #isOpen = true;

  private constructor(opts: {
    path: string;
    uuid: string;
    profile: { name: string; email?: string };
    header: VaultHeader;
    boxStore: BoxStore;
    boxName: string;
    masterKey: Uint8Array;
  }) {
    this.path = opts.path;
    this.legacyLedgerPath = join(dirname(opts.path), "spend-ledger.jsonl");
    this.ledgerPath = join(dirname(opts.path), "ledger.box");
    this.uuid = opts.uuid;
    this.#profile = opts.profile;
    this.#header = opts.header;
    this.#boxStore = opts.boxStore;
    this.#boxName = opts.boxName;
    this.#masterKey = opts.masterKey;
    this.ledger = new VaultLedger({
      path: this.ledgerPath,
      legacyPath: this.legacyLedgerPath,
      vaultUuid: opts.uuid,
      key: opts.masterKey,
      kdf: opts.header.kdf
    });
  }

  static async init(opts: VaultInitOptions): Promise<BuyerVault> {
    const keystore = opts.keystore ?? osKeystore();
    const location = vaultLocation(opts.path ?? defaultVaultPath(), opts.boxStore);
    if (await location.boxStore.read(location.name)) {
      throw new Error(`vault file already exists at ${location.path}`);
    }

    const passwordKey = isPasswordKeystore(keystore)
      ? await keystore.createMasterKey()
      : null;
    const header = createVaultHeader({ kdf: passwordKey?.kdf ?? null });
    const account = accountForVault(header.uuid);
    const masterKey = passwordKey?.key ?? new Uint8Array(randomBytes(VAULT_KEY_BYTES));
    let keyStored = false;
    let boxWritten = false;

    try {
      if (!passwordKey) {
        await keystore.setMasterKey(VAULT_KEY_SERVICE, account, masterKey);
        keyStored = true;
      }
      await writeRecord(location.boxStore, location.name, header, masterKey, {
        profile: opts.profile,
        cards: [],
        addresses: []
      });
      boxWritten = true;
      return new BuyerVault({
        path: location.path,
        uuid: header.uuid,
        profile: opts.profile,
        header,
        boxStore: location.boxStore,
        boxName: location.name,
        masterKey
      });
    } catch (error) {
      if (boxWritten) await location.boxStore.delete(location.name);
      if (keyStored) await keystore.deleteMasterKey(VAULT_KEY_SERVICE, account);
      masterKey.fill(0);
      throw error;
    }
  }

  static async initGlobal(opts: VaultInitOptions): Promise<BuyerVault> {
    return BuyerVault.init({ ...opts, path: opts.path ?? defaultVaultPath() });
  }

  static async initProject(opts: VaultInitOptions): Promise<BuyerVault> {
    return BuyerVault.init({ ...opts, path: opts.path ?? projectVaultPath() });
  }

  static async open(opts: VaultOpenOptions): Promise<BuyerVault> {
    const location = vaultLocation(opts.path, opts.boxStore);
    const keystore = opts.keystore ?? osKeystore();
    const bytes = await location.boxStore.read(location.name);
    if (!bytes) throw new Error(`vault file not found at ${location.path}`);

    const packed = unpackVaultBox(bytes);
    const header = parseVaultHeader(packed.header);
    const account = accountForVault(header.uuid);
    const masterKey = await masterKeyForOpen(keystore, header, account);
    const record = readRecord(packed, header, masterKey);

    const vault = new BuyerVault({
      path: location.path,
      uuid: header.uuid,
      profile: record.profile,
      header,
      boxStore: location.boxStore,
      boxName: location.name,
      masterKey
    });
    await vault.ledger.migrateLegacyIfNeeded();
    await vault.ledger.releaseExpiredEscalations(systemClock());
    return vault;
  }

  static async openGlobal(opts: { keystore?: Keystore } = {}): Promise<BuyerVault> {
    return BuyerVault.open({ path: defaultVaultPath(), keystore: opts.keystore });
  }

  static async openProject(opts: { keystore?: Keystore } = {}): Promise<BuyerVault> {
    return BuyerVault.open({ path: projectVaultPath(), keystore: opts.keystore });
  }

  static async importKeyFromFile(opts: {
    path: string;
    vaultPath: string;
    recoveryPassword: string;
  }): Promise<void> {
    await importKeyFromRecoveryFile(opts);
  }

  get profile(): { name: string; email?: string } {
    this.assertOpen();
    return { ...this.#profile };
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  async addCard(card: NewCard): Promise<CardMetadata> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    const stored = createStoredCard(card, card.id ?? nextId("card"));
    if (record.cards.some((existing) => existing.id === stored.id)) {
      throw new Error(`card already exists: ${stored.id}`);
    }
    record.cards.push(stored);
    await this.writeCurrentRecord(record);
    return cardMetadata(stored);
  }

  async removeCard(id: string): Promise<void> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    const next = record.cards.filter((card) => card.id !== id);
    if (next.length === record.cards.length) throw new Error(`card not found: ${id}`);
    record.cards = next;
    await this.writeCurrentRecord(record);
  }

  async listCards(): Promise<CardMetadata[]> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    return record.cards.map(cardMetadata);
  }

  async pickCard(opts: { merchant: string }): Promise<CardMetadata | null> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    const card = pickStoredCard(record.cards, opts.merchant);
    return card ? cardMetadata(card) : null;
  }

  async revealCard(id: string): Promise<RawCard> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    const card = record.cards.find((candidate) => candidate.id === id);
    if (!card) throw new Error(`card not found: ${id}`);
    return rawCard(card);
  }

  async addAddress(address: NewAddress): Promise<BillingAddress> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    const stored = createStoredAddress(address, address.id ?? nextId("addr"), {
      makeDefault: record.addresses.length === 0
    });
    if (record.addresses.some((existing) => existing.id === stored.id)) {
      throw new Error(`address already exists: ${stored.id}`);
    }
    record.addresses.push(stored);
    await this.writeCurrentRecord(record);
    return publicAddress(stored);
  }

  async removeAddress(id: string): Promise<void> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    const removed = record.addresses.find((address) => address.id === id);
    if (!removed) throw new Error(`address not found: ${id}`);
    record.addresses = record.addresses.filter((address) => address.id !== id);
    if (removed.default && record.addresses.length) {
      record.addresses[0]!.default = true;
    }
    await this.writeCurrentRecord(record);
  }

  async setDefaultAddress(id: string): Promise<void> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    if (!record.addresses.some((address) => address.id === id)) {
      throw new Error(`address not found: ${id}`);
    }
    record.addresses = record.addresses.map((address) => ({ ...address, default: address.id === id }));
    await this.writeCurrentRecord(record);
  }

  async listAddresses(): Promise<BillingAddress[]> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    return record.addresses.map(publicAddress);
  }

  async billing(opts: { addressId?: string } = {}): Promise<BillingPayload> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    const address = opts.addressId
      ? record.addresses.find((candidate) => candidate.id === opts.addressId)
      : record.addresses.find((candidate) => candidate.default) ?? record.addresses[0];
    if (!address) throw new Error("no billing address configured");
    return {
      name: record.profile.name,
      ...(record.profile.email ? { email: record.profile.email } : {}),
      address: publicAddress(address)
    };
  }

  async createMandateKey(): Promise<MandateKeyMetadata> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    if (record.mandateKey) return mandateKeyMetadata(record.mandateKey);
    record.mandateKey = createStoredMandateKey();
    await this.writeCurrentRecord(record);
    return mandateKeyMetadata(record.mandateKey);
  }

  async hasMandateKey(): Promise<boolean> {
    this.assertOpen();
    return !!(await this.readCurrentRecord()).mandateKey;
  }

  async exportMandatePublicKey(): Promise<{ jwk: JsonWebKey; key_id: string }> {
    this.assertOpen();
    return mandatePublicKey(await this.requireMandateKey());
  }

  async mandatePublicKey(): Promise<{ jwk: JsonWebKey; key_id: string }> {
    return this.exportMandatePublicKey();
  }

  async signMandate(payload: object): Promise<{ jwt: string; key_id: string }> {
    this.assertOpen();
    return signMandateJwt(await this.requireMandateKey(), payload);
  }

  async pairwiseSubject(audience: string): Promise<string> {
    this.assertOpen();
    return derivePairwiseSubject(await this.requireMandateKey(), audience);
  }

  async createUcpSigningKey(opts: { algorithm: HmsAlgorithm }): Promise<UcpSigningKeyMetadata> {
    this.assertOpen();
    const record = await this.readCurrentRecord();
    if (record.ucpSigningKey) {
      if (record.ucpSigningKey.algorithm !== opts.algorithm) {
        throw new Error(`UCP signing key already exists with algorithm ${record.ucpSigningKey.algorithm}`);
      }
      return ucpSigningKeyMetadata(record.ucpSigningKey);
    }
    record.ucpSigningKey = createStoredUcpSigningKey(opts);
    await this.writeCurrentRecord(record);
    return ucpSigningKeyMetadata(record.ucpSigningKey);
  }

  async hasUcpSigningKey(): Promise<boolean> {
    this.assertOpen();
    return !!(await this.readCurrentRecord()).ucpSigningKey;
  }

  async exportUcpSigningPublicKey(): Promise<EcJwk> {
    this.assertOpen();
    return ucpSigningPublicKey(await this.requireUcpSigningKey());
  }

  async signWithUcpKey(args: { data: Uint8Array; algorithm: HmsAlgorithm }): Promise<Uint8Array> {
    this.assertOpen();
    return await signWithStoredUcpKey(await this.requireUcpSigningKey(), args);
  }

  async recordSpend(receipt: SpendReceipt): Promise<void> {
    this.assertOpen();
    await this.ledger.recordSpend(receipt);
  }

  async spendInWindow(window: SpendWindow, currency: string): Promise<SpendWindowUsage> {
    this.assertOpen();
    return this.ledger.spendInWindow(window, currency);
  }

  async spendInWindowDetailed(window: SpendWindow, currency: string): Promise<SpendWindowDetailedUsage> {
    this.assertOpen();
    return this.ledger.spendInWindowDetailed(window, currency);
  }

  async listSpend(opts: { since?: Date; until?: Date } = {}): Promise<SpendReceipt[]> {
    this.assertOpen();
    return this.ledger.listSpend(opts);
  }

  async listReceipts(opts: { since?: Date; until?: Date } = {}): Promise<Receipt[]> {
    this.assertOpen();
    return this.ledger.listReceipts(opts);
  }

  async reserve(args: ReserveArgs): Promise<Reservation> {
    this.assertOpen();
    return this.ledger.reserve(args);
  }

  async adjustReservation(id: string, finalTotal: number, at: Date): Promise<void> {
    this.assertOpen();
    await this.ledger.adjust(id, finalTotal, at);
  }

  async markReservationEscalated(id: string, expires_at: string, at: Date): Promise<void> {
    this.assertOpen();
    await this.ledger.markEscalated(id, expires_at, at);
  }

  async releaseReservation(id: string, errorSummary: string, at: Date): Promise<void> {
    this.assertOpen();
    await this.ledger.release(id, errorSummary, at);
  }

  async settleReservation(id: string, receipt: Receipt, at: Date): Promise<void> {
    this.assertOpen();
    await this.ledger.settle(id, receipt, at);
  }

  async writeShadowReceipt(id: string, receipt: Receipt, at: Date): Promise<void> {
    this.assertOpen();
    await this.ledger.writeShadowReceipt(id, receipt, at);
  }

  async reattachReservation(id: string, at: Date): Promise<Reservation> {
    this.assertOpen();
    return this.ledger.reattach(id, at);
  }

  async pendingReservations(): Promise<Reservation[]> {
    this.assertOpen();
    return this.ledger.pendingReservations();
  }

  async shadowReceipt(id: string): Promise<Receipt | undefined> {
    this.assertOpen();
    return this.ledger.shadowReceipt(id);
  }

  async exportKeyToFile(opts: { path: string; recoveryPassword: string }): Promise<string> {
    this.assertOpen();
    return exportKeyToRecoveryFile({
      path: opts.path,
      recoveryPassword: opts.recoveryPassword,
      vaultUuid: this.uuid,
      masterKey: this.#masterKey
    });
  }

  async exportKey_UNSAFE(): Promise<string> {
    this.assertOpen();
    return exportKeyUnsafe(this.#masterKey);
  }

  async close(): Promise<void> {
    if (!this.#isOpen) return;
    this.#masterKey.fill(0);
    this.#isOpen = false;
  }

  private async readCurrentRecord(): Promise<VaultRecord> {
    const bytes = await this.#boxStore.read(this.#boxName);
    if (!bytes) throw new Error(`vault file not found at ${this.path}`);
    const packed = unpackVaultBox(bytes);
    const header = parseVaultHeader(packed.header);
    return readRecord(packed, header, this.#masterKey);
  }

  private async writeCurrentRecord(record: VaultRecord): Promise<void> {
    await writeRecord(this.#boxStore, this.#boxName, this.#header, this.#masterKey, record);
  }

  private async requireMandateKey(): Promise<StoredMandateKey> {
    const key = (await this.readCurrentRecord()).mandateKey;
    if (!key) throw new MandateKeyMissing();
    return key;
  }

  private async requireUcpSigningKey(): Promise<StoredUcpSigningKey> {
    const key = (await this.readCurrentRecord()).ucpSigningKey;
    if (!key) throw new UcpSigningKeyMissing();
    return key;
  }

  private assertOpen(): void {
    if (!this.#isOpen) throw new Error("vault is closed");
  }
}

export function accountForVault(uuid: string): string {
  return createHash("sha256").update(uuid).digest("hex");
}

function defaultVaultPath(): string {
  return join(homedir(), ".steelyard", "vault.box");
}

function projectVaultPath(): string {
  return resolve(".steelyard", "vault.box");
}

function vaultLocation(path: string, boxStore?: BoxStore): { path: string; name: string; boxStore: BoxStore } {
  const absolute = resolve(path);
  return {
    path: absolute,
    name: basename(absolute),
    boxStore: boxStore ?? fileBoxStore(dirname(absolute))
  };
}

async function masterKeyForOpen(
  keystore: Keystore,
  header: VaultHeader,
  account: string
): Promise<Uint8Array> {
  if (header.kdf) {
    if (!isPasswordKeystore(keystore)) {
      throw new Error("password keystore required for kdf-backed vault");
    }
    return keystore.deriveMasterKey(header.kdf);
  }

  if (isPasswordKeystore(keystore)) {
    throw new Error("this vault was inited with a different keystore");
  }

  const masterKey = await keystore.getMasterKey(VAULT_KEY_SERVICE, account);
  if (!masterKey) throw new Error(`vault key not found in keychain for uuid ${header.uuid}`);
  return masterKey;
}

async function writeRecord(
  boxStore: BoxStore,
  name: string,
  header: VaultHeader,
  masterKey: Uint8Array,
  record: VaultRecord
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const sealed = sealVaultBox({ key: masterKey, header, plaintext });
  await boxStore.write(name, packVaultBox(sealed));
}

function readRecord(
  packed: ReturnType<typeof unpackVaultBox>,
  header: VaultHeader,
  masterKey: Uint8Array
): VaultRecord {
  const plaintext = openVaultBox({
    key: masterKey,
    header,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  });
  return normalizeVaultRecord(JSON.parse(new TextDecoder().decode(plaintext)));
}

function normalizeVaultRecord(value: unknown): VaultRecord {
  if (!value || typeof value !== "object") throw new Error("vault record is malformed");
  const record = value as Partial<VaultRecord>;
  if (!record.profile || typeof record.profile.name !== "string") {
    throw new Error("vault profile is malformed");
  }
  const mandateKey = normalizeStoredMandateKey(record.mandateKey);
  const ucpSigningKey = normalizeStoredUcpSigningKey(record.ucpSigningKey);
  return {
    profile: {
      name: record.profile.name,
      ...(typeof record.profile.email === "string" ? { email: record.profile.email } : {})
    },
    cards: Array.isArray(record.cards) ? (record.cards as StoredCard[]) : [],
    addresses: Array.isArray(record.addresses) ? (record.addresses as StoredAddress[]) : [],
    ...(mandateKey ? { mandateKey } : {}),
    ...(ucpSigningKey ? { ucpSigningKey } : {})
  };
}

function nextId(prefix: "card" | "addr"): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}
