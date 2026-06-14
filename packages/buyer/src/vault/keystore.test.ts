import { describe, expect, it, vi, beforeEach } from "vitest";

const keyringState = vi.hoisted(() => ({
  secrets: new Map<string, Uint8Array>(),
  failOperation: null as null | "get" | "set" | "delete",
  noEntryOnMissing: false
}));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class MockAsyncEntry {
    readonly #key: string;

    constructor(service: string, account: string) {
      this.#key = `${service}\0${account}`;
    }

    async getSecret(): Promise<Uint8Array | undefined> {
      if (keyringState.failOperation === "get") throw new Error("locked keychain");
      const secret = keyringState.secrets.get(this.#key);
      if (!secret && keyringState.noEntryOnMissing) throw new Error("NoEntry");
      return secret ? new Uint8Array(secret) : undefined;
    }

    async setSecret(secret: Uint8Array): Promise<void> {
      if (keyringState.failOperation === "set") throw new Error("locked keychain");
      keyringState.secrets.set(this.#key, new Uint8Array(secret));
    }

    async deleteCredential(): Promise<boolean> {
      if (keyringState.failOperation === "delete") throw new Error("locked keychain");
      if (!keyringState.secrets.delete(this.#key) && keyringState.noEntryOnMissing) {
        throw new Error("NoEntry");
      }
      return true;
    }
  }
}));

const {
  DEFAULT_ARGON2ID_KDF,
  VAULT_KEY_SERVICE,
  isPasswordKeystore,
  memoryKeystore,
  osKeystore,
  passwordKeystore,
  passwordKeystoreWithParams
} = await import("./keystore.js");

describe("vault keystores", () => {
  beforeEach(() => {
    keyringState.secrets.clear();
    keyringState.failOperation = null;
    keyringState.noEntryOnMissing = false;
  });

  it("stores OS keychain master keys as defensive copies", async () => {
    const keystore = osKeystore();
    const key = new Uint8Array(32).fill(7);

    await keystore.setMasterKey(VAULT_KEY_SERVICE, "account", key);
    key.fill(1);

    const stored = await keystore.getMasterKey(VAULT_KEY_SERVICE, "account");
    expect(stored).toEqual(new Uint8Array(32).fill(7));
    stored!.fill(2);
    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "account")).resolves.toEqual(
      new Uint8Array(32).fill(7)
    );

    await keystore.deleteMasterKey(VAULT_KEY_SERVICE, "account");
    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "account")).resolves.toBeNull();
  });

  it("maps missing OS keychain entries to null and validates key length", async () => {
    const keystore = osKeystore();
    keyringState.noEntryOnMissing = true;

    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "missing")).resolves.toBeNull();
    await expect(keystore.deleteMasterKey(VAULT_KEY_SERVICE, "missing")).resolves.toBeUndefined();
    await expect(
      keystore.setMasterKey(VAULT_KEY_SERVICE, "short", new Uint8Array(31))
    ).rejects.toThrow(/vault master key must be 32 bytes/);
  });

  it("wraps OS keychain availability errors with the password-keystore fix", async () => {
    const keystore = osKeystore();

    keyringState.failOperation = "get";
    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "account")).rejects.toThrow(
      /Use passwordKeystore/
    );

    keyringState.failOperation = "set";
    await expect(
      keystore.setMasterKey(VAULT_KEY_SERVICE, "account", new Uint8Array(32))
    ).rejects.toThrow(/Use passwordKeystore/);

    keyringState.failOperation = "delete";
    await expect(keystore.deleteMasterKey(VAULT_KEY_SERVICE, "account")).rejects.toThrow(
      /Use passwordKeystore/
    );
  });

  it("derives password master keys from stored Argon2id parameters", async () => {
    const keystore = passwordKeystoreWithParams({
      password: "vault password",
      iterations: 1,
      memory_kib: 64,
      parallelism: 1
    });
    expect(isPasswordKeystore(keystore)).toBe(true);
    if (!isPasswordKeystore(keystore)) throw new Error("expected password keystore");

    const created = await keystore.createMasterKey();
    expect(created.key).toHaveLength(32);
    expect(created.kdf).toMatchObject({
      type: "argon2id",
      iterations: 1,
      memory_kib: 64,
      parallelism: 1
    });

    await expect(keystore.deriveMasterKey(created.kdf)).resolves.toEqual(created.key);
    const wrongPassword = passwordKeystoreWithParams({
      password: "wrong password",
      iterations: 1,
      memory_kib: 64,
      parallelism: 1
    });
    if (!isPasswordKeystore(wrongPassword)) throw new Error("expected password keystore");
    await expect(wrongPassword.deriveMasterKey(created.kdf)).resolves.not.toEqual(created.key);
    await expect(
      keystore.deriveMasterKey({ ...created.kdf, type: "scrypt" as "argon2id" })
    ).rejects.toThrow(/unsupported vault kdf/);
  });

  it("keeps passwordKeystore on the required default Argon2id cost profile", async () => {
    const keystore = passwordKeystore({ password: "vault password" });
    expect(isPasswordKeystore(keystore)).toBe(true);
    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "account")).resolves.toBeNull();
    await expect(
      keystore.setMasterKey(VAULT_KEY_SERVICE, "account", new Uint8Array(32))
    ).resolves.toBeUndefined();
    await expect(keystore.deleteMasterKey(VAULT_KEY_SERVICE, "account")).resolves.toBeUndefined();
    expect(DEFAULT_ARGON2ID_KDF).toEqual({
      iterations: 3,
      memory_kib: 65_536,
      parallelism: 4
    });
  });

  it("keeps memory keystore values isolated from callers", async () => {
    const keystore = memoryKeystore();
    const key = new Uint8Array(32).fill(9);
    await keystore.setMasterKey(VAULT_KEY_SERVICE, "account", key);
    key.fill(0);
    const stored = await keystore.getMasterKey(VAULT_KEY_SERVICE, "account");
    expect(stored).toEqual(new Uint8Array(32).fill(9));
    stored!.fill(1);
    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "account")).resolves.toEqual(
      new Uint8Array(32).fill(9)
    );
    await keystore.deleteMasterKey(VAULT_KEY_SERVICE, "account");
    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "account")).resolves.toBeNull();
  });
});
