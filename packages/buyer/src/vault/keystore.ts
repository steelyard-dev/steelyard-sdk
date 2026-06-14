import { AsyncEntry } from "@napi-rs/keyring";
import { argon2idAsync } from "@noble/hashes/argon2";
import { randomBytes } from "node:crypto";
import { VAULT_KEY_BYTES } from "./crypto.js";
import type { VaultHeader } from "./header.js";

export const VAULT_KEY_SERVICE = "dev.steelyard.vault";
export const DEFAULT_ARGON2ID_KDF = {
  iterations: 3,
  memory_kib: 65_536,
  parallelism: 4
} as const;

const PASSWORD_KEYSTORE = Symbol("steelyard.passwordKeystore");
const PASSWORD_SALT_BYTES = 16;

export interface Keystore {
  getMasterKey(service: string, account: string): Promise<Uint8Array | null>;
  setMasterKey(service: string, account: string, key: Uint8Array): Promise<void>;
  deleteMasterKey(service: string, account: string): Promise<void>;
}

type VaultKdf = NonNullable<VaultHeader["kdf"]>;
type Argon2idCost = Pick<VaultKdf, "iterations" | "memory_kib" | "parallelism">;

export interface PasswordKeystore extends Keystore {
  readonly [PASSWORD_KEYSTORE]: true;
  createMasterKey(): Promise<{ key: Uint8Array; kdf: VaultKdf }>;
  deriveMasterKey(kdf: VaultKdf): Promise<Uint8Array>;
}

export function osKeystore(): Keystore {
  return {
    async getMasterKey(service, account) {
      try {
        const secret = await new AsyncEntry(service, account).getSecret();
        return secret ? new Uint8Array(secret) : null;
      } catch (error) {
        if (isMissingKeyringEntry(error)) return null;
        throw keychainUnavailable(error);
      }
    },
    async setMasterKey(service, account, key) {
      assertMasterKey(key);
      try {
        await new AsyncEntry(service, account).setSecret(new Uint8Array(key));
      } catch (error) {
        throw keychainUnavailable(error);
      }
    },
    async deleteMasterKey(service, account) {
      try {
        await new AsyncEntry(service, account).deleteCredential();
      } catch (error) {
        if (!isMissingKeyringEntry(error)) throw keychainUnavailable(error);
      }
    }
  };
}

export function passwordKeystore(opts: { password: string }): Keystore {
  return passwordKeystoreWithParams({
    password: opts.password,
    ...DEFAULT_ARGON2ID_KDF
  });
}

export function passwordKeystoreWithParams(opts: { password: string } & Argon2idCost): Keystore {
  const password = opts.password;
  const keystore: PasswordKeystore = {
    [PASSWORD_KEYSTORE]: true,
    async getMasterKey() {
      return null;
    },
    async setMasterKey() {
      return undefined;
    },
    async deleteMasterKey() {
      return undefined;
    },
    async createMasterKey() {
      const salt = new Uint8Array(randomBytes(PASSWORD_SALT_BYTES));
      const kdf: VaultKdf = {
        type: "argon2id",
        salt: Buffer.from(salt).toString("base64"),
        iterations: opts.iterations,
        memory_kib: opts.memory_kib,
        parallelism: opts.parallelism
      };
      return { key: await derivePasswordKey(password, kdf), kdf };
    },
    async deriveMasterKey(kdf) {
      return derivePasswordKey(password, kdf);
    }
  };
  return keystore;
}

export function memoryKeystore(): Keystore {
  const keys = new Map<string, Uint8Array>();
  const scoped = (service: string, account: string) => `${service}\0${account}`;

  return {
    async getMasterKey(service, account) {
      const key = keys.get(scoped(service, account));
      return key ? new Uint8Array(key) : null;
    },
    async setMasterKey(service, account, key) {
      keys.set(scoped(service, account), new Uint8Array(key));
    },
    async deleteMasterKey(service, account) {
      keys.delete(scoped(service, account));
    }
  };
}

export function isPasswordKeystore(keystore: Keystore): keystore is PasswordKeystore {
  return (keystore as Partial<PasswordKeystore>)[PASSWORD_KEYSTORE] === true;
}

async function derivePasswordKey(password: string, kdf: VaultKdf): Promise<Uint8Array> {
  if (kdf.type !== "argon2id") throw new Error(`unsupported vault kdf ${kdf.type}`);
  const salt = Buffer.from(kdf.salt, "base64");
  const key = await argon2idAsync(new TextEncoder().encode(password), salt, {
    t: kdf.iterations,
    m: kdf.memory_kib,
    p: kdf.parallelism,
    dkLen: VAULT_KEY_BYTES
  });
  assertMasterKey(key);
  return key;
}

function assertMasterKey(key: Uint8Array): void {
  if (key.length !== VAULT_KEY_BYTES) {
    throw new Error(`vault master key must be ${VAULT_KEY_BYTES} bytes`);
  }
}

function isMissingKeyringEntry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bNoEntry\b|not found|no entry/i.test(message);
}

function keychainUnavailable(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    "OS keychain unavailable for Steelyard vault. Use passwordKeystore({ password }) " +
      "on headless Linux, CI, SSH, or containers; otherwise unlock or configure your OS keychain. " +
      `Original error: ${message}`
  );
}
