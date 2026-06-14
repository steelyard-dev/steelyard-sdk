import { randomBytes, createHash } from "node:crypto";
import { dirname, basename, resolve, join } from "node:path";
import { fileBoxStore, type BoxStore } from "./boxstore.js";
import { openVaultBox, sealVaultBox, VAULT_KEY_BYTES } from "./crypto.js";
import { packVaultBox, unpackVaultBox } from "./format.js";
import { createVaultHeader, type VaultHeader } from "./header.js";
import { VAULT_KEY_SERVICE, type Keystore } from "./keystore.js";

export interface VaultInitOptions {
  profile: { name: string; email?: string };
  path: string;
  keystore: Keystore;
  boxStore?: BoxStore;
}

export interface VaultOpenOptions {
  path: string;
  keystore: Keystore;
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
    const location = vaultLocation(opts.path, opts.boxStore);
    if (await location.boxStore.read(location.name)) {
      throw new Error(`vault file already exists at ${location.path}`);
    }

    const header = createVaultHeader();
    const account = accountForVault(header.uuid);
    const masterKey = new Uint8Array(randomBytes(VAULT_KEY_BYTES));
    let keyStored = false;
    let boxWritten = false;

    try {
      await opts.keystore.setMasterKey(VAULT_KEY_SERVICE, account, masterKey);
      keyStored = true;
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
      if (keyStored) await opts.keystore.deleteMasterKey(VAULT_KEY_SERVICE, account);
      masterKey.fill(0);
      throw error;
    }
  }

  static async open(opts: VaultOpenOptions): Promise<BuyerVault> {
    const location = vaultLocation(opts.path, opts.boxStore);
    const bytes = await location.boxStore.read(location.name);
    if (!bytes) throw new Error(`vault file not found at ${location.path}`);

    const packed = unpackVaultBox(bytes);
    const header = parseHeader(packed.header);
    const account = accountForVault(header.uuid);
    const masterKey = await opts.keystore.getMasterKey(VAULT_KEY_SERVICE, account);
    if (!masterKey) throw new Error(`vault key not found in keychain for uuid ${header.uuid}`);
    const record = readRecord(packed, header, masterKey);

    return new BuyerVault({
      path: location.path,
      uuid: header.uuid,
      profile: record.profile,
      masterKey
    });
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

function vaultLocation(path: string, boxStore?: BoxStore): { path: string; name: string; boxStore: BoxStore } {
  const absolute = resolve(path);
  return {
    path: absolute,
    name: basename(absolute),
    boxStore: boxStore ?? fileBoxStore(dirname(absolute))
  };
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
  if (parsed.version !== 1 || parsed.alg !== "xsalsa20-poly1305" || typeof parsed.uuid !== "string") {
    throw new Error("vault header is unsupported");
  }
  return parsed;
}
