import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, basename, resolve, join } from "node:path";
import { fileBoxStore, type BoxStore } from "./boxstore.js";
import { openVaultBox, sealVaultBox, VAULT_KEY_BYTES } from "./crypto.js";
import { packVaultBox, unpackVaultBox } from "./format.js";
import { createVaultHeader, type VaultHeader } from "./header.js";
import {
  VAULT_KEY_SERVICE,
  isPasswordKeystore,
  osKeystore,
  type Keystore
} from "./keystore.js";

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
  cards: unknown[];
  addresses: unknown[];
}

export class BuyerVault {
  readonly path: string;
  readonly ledgerPath: string;
  readonly uuid: string;
  #profile: { name: string; email?: string };
  #masterKey: Uint8Array;
  #isOpen = true;

  private constructor(opts: {
    path: string;
    uuid: string;
    profile: { name: string; email?: string };
    masterKey: Uint8Array;
  }) {
    this.path = opts.path;
    this.ledgerPath = join(dirname(opts.path), "spend-ledger.jsonl");
    this.uuid = opts.uuid;
    this.#profile = opts.profile;
    this.#masterKey = opts.masterKey;
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
    const header = parseHeader(packed.header);
    const account = accountForVault(header.uuid);
    const masterKey = await masterKeyForOpen(keystore, header, account);
    const record = readRecord(packed, header, masterKey);

    return new BuyerVault({
      path: location.path,
      uuid: header.uuid,
      profile: record.profile,
      masterKey
    });
  }

  static async openGlobal(opts: { keystore?: Keystore } = {}): Promise<BuyerVault> {
    return BuyerVault.open({ path: defaultVaultPath(), keystore: opts.keystore });
  }

  static async openProject(opts: { keystore?: Keystore } = {}): Promise<BuyerVault> {
    return BuyerVault.open({ path: projectVaultPath(), keystore: opts.keystore });
  }

  get profile(): { name: string; email?: string } {
    this.assertOpen();
    return { ...this.#profile };
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  async close(): Promise<void> {
    if (!this.#isOpen) return;
    this.#masterKey.fill(0);
    this.#isOpen = false;
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
  return JSON.parse(new TextDecoder().decode(plaintext)) as VaultRecord;
}

function parseHeader(bytes: Uint8Array): VaultHeader {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as VaultHeader;
  if (
    parsed.version !== 1 ||
    parsed.alg !== "xsalsa20-poly1305" ||
    typeof parsed.uuid !== "string" ||
    !validKdf(parsed.kdf)
  ) {
    throw new Error("vault header is unsupported");
  }
  return parsed;
}

function validKdf(kdf: VaultHeader["kdf"]): boolean {
  if (kdf === null) return true;
  return (
    typeof kdf === "object" &&
    kdf.type === "argon2id" &&
    typeof kdf.salt === "string" &&
    Number.isInteger(kdf.iterations) &&
    kdf.iterations > 0 &&
    Number.isInteger(kdf.memory_kib) &&
    kdf.memory_kib > 0 &&
    Number.isInteger(kdf.parallelism) &&
    kdf.parallelism > 0
  );
}
