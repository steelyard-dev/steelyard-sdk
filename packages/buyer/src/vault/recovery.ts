import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { argon2idAsync } from "@noble/hashes/argon2";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { unpackVaultBox } from "./format.js";
import { parseVaultHeader, type VaultHeader } from "./header.js";
import { DEFAULT_ARGON2ID_KDF, VAULT_KEY_SERVICE, osKeystore } from "./keystore.js";
import { VAULT_KEY_BYTES, VAULT_NONCE_BYTES } from "./crypto.js";

interface RecoveryKdf {
  type: "argon2id";
  salt: string;
  iterations: number;
  memory_kib: number;
  parallelism: number;
}

interface RecoveryFile {
  version: 1;
  vault_uuid: string;
  kdf: RecoveryKdf;
  wrapped_key: string;
}

let recoveryWarningShown = false;

export async function exportKeyToRecoveryFile(opts: {
  path: string;
  recoveryPassword: string;
  vaultUuid: string;
  masterKey: Uint8Array;
}): Promise<string> {
  const location = resolve(opts.path);
  await assertRecoveryTargetAvailable(location);
  const salt = new Uint8Array(randomBytes(16));
  const kdf: RecoveryKdf = {
    type: "argon2id",
    salt: Buffer.from(salt).toString("base64"),
    iterations: DEFAULT_ARGON2ID_KDF.iterations,
    memory_kib: DEFAULT_ARGON2ID_KDF.memory_kib,
    parallelism: DEFAULT_ARGON2ID_KDF.parallelism
  };
  const wrapKey = await deriveRecoveryKey(opts.recoveryPassword, kdf);
  const wrapped = wrapMasterKey(wrapKey, opts.masterKey);
  wrapKey.fill(0);

  await mkdir(dirname(location), { recursive: true, mode: 0o700 });
  await chmod(dirname(location), 0o700);
  await writeFile(
    location,
    JSON.stringify(
      {
        version: 1,
        vault_uuid: opts.vaultUuid,
        kdf,
        wrapped_key: Buffer.from(wrapped).toString("base64")
      } satisfies RecoveryFile,
      null,
      2
    ) + "\n",
    { mode: 0o600, flag: "wx" }
  );
  await chmod(location, 0o600);
  warnRecoveryWritten(location);
  return location;
}

export async function importKeyFromRecoveryFile(opts: {
  path: string;
  vaultPath: string;
  recoveryPassword: string;
}): Promise<void> {
  const recovery = parseRecoveryFile(JSON.parse(await readFile(resolve(opts.path), "utf8")));
  const vaultHeader = await readVaultHeaderFromFile(opts.vaultPath);
  if (recovery.vault_uuid !== vaultHeader.uuid) {
    throw new Error("recovery file does not match vault uuid");
  }

  const keystore = osKeystore();
  const account = accountForUuid(vaultHeader.uuid);
  if (await keystore.getMasterKey(VAULT_KEY_SERVICE, account)) {
    throw new Error(`vault key already installed for uuid ${vaultHeader.uuid}`);
  }

  const wrapKey = await deriveRecoveryKey(opts.recoveryPassword, recovery.kdf);
  const masterKey = unwrapMasterKey(wrapKey, Buffer.from(recovery.wrapped_key, "base64"));
  wrapKey.fill(0);
  try {
    await keystore.setMasterKey(VAULT_KEY_SERVICE, account, masterKey);
  } finally {
    masterKey.fill(0);
  }
}

export async function readVaultHeaderFromFile(path: string): Promise<VaultHeader> {
  const bytes = new Uint8Array(await readFile(resolve(path)));
  return parseVaultHeader(unpackVaultBox(bytes).header);
}

export function exportKeyUnsafe(masterKey: Uint8Array): string {
  return Buffer.from(masterKey).toString("base64");
}

export function _resetRecoveryWarningForTests(): void {
  recoveryWarningShown = false;
}

async function deriveRecoveryKey(password: string, kdf: RecoveryKdf): Promise<Uint8Array> {
  if (kdf.type !== "argon2id") throw new Error(`unsupported recovery kdf ${kdf.type}`);
  const key = await argon2idAsync(new TextEncoder().encode(password), Buffer.from(kdf.salt, "base64"), {
    t: kdf.iterations,
    m: kdf.memory_kib,
    p: kdf.parallelism,
    dkLen: VAULT_KEY_BYTES
  });
  if (key.length !== VAULT_KEY_BYTES) throw new Error(`recovery key must be ${VAULT_KEY_BYTES} bytes`);
  return key;
}

function wrapMasterKey(wrapKey: Uint8Array, masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== VAULT_KEY_BYTES) throw new Error(`vault master key must be ${VAULT_KEY_BYTES} bytes`);
  const nonce = new Uint8Array(randomBytes(VAULT_NONCE_BYTES));
  const ciphertext = xsalsa20poly1305(wrapKey, nonce).encrypt(masterKey);
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

function unwrapMasterKey(wrapKey: Uint8Array, wrapped: Uint8Array): Uint8Array {
  if (wrapped.length <= VAULT_NONCE_BYTES) throw new Error("recovery wrapped_key is malformed");
  const nonce = wrapped.slice(0, VAULT_NONCE_BYTES);
  const ciphertext = wrapped.slice(VAULT_NONCE_BYTES);
  const masterKey = xsalsa20poly1305(wrapKey, nonce).decrypt(ciphertext);
  if (masterKey.length !== VAULT_KEY_BYTES) throw new Error("recovery master key is malformed");
  return masterKey;
}

function parseRecoveryFile(value: unknown): RecoveryFile {
  if (!value || typeof value !== "object") throw new Error("recovery file is malformed");
  const file = value as Partial<RecoveryFile>;
  if (file.version !== 1 || typeof file.vault_uuid !== "string") {
    throw new Error("recovery file is unsupported");
  }
  if (!validKdf(file.kdf)) throw new Error("recovery kdf is unsupported");
  if (typeof file.wrapped_key !== "string") throw new Error("recovery wrapped_key is required");
  return {
    version: 1,
    vault_uuid: file.vault_uuid,
    kdf: file.kdf,
    wrapped_key: file.wrapped_key
  };
}

function validKdf(kdf: RecoveryFile["kdf"] | undefined): kdf is RecoveryKdf {
  return (
    !!kdf &&
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

function accountForUuid(uuid: string): string {
  return createHash("sha256").update(uuid).digest("hex");
}

async function assertRecoveryTargetAvailable(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`recovery file already exists at ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function warnRecoveryWritten(path: string): void {
  if (recoveryWarningShown) return;
  recoveryWarningShown = true;
  process.stderr.write(
    `⚠ steelyard/buyer/vault: master key recovery file written to ${path}.\n` +
      "  Store this file + the recoveryPassword somewhere SAFE and separate\n" +
      "  from your usual storage. Anyone with both can decrypt every card in this vault.\n"
  );
}
