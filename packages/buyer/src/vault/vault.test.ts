import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BuyerVault,
  memoryBoxStore,
  memoryKeystore,
  passwordKeystore
} from "./index.js";
import { unpackVaultBox } from "./format.js";
import { VAULT_KEY_SERVICE, passwordKeystoreWithParams } from "./keystore.js";
import { accountForVault } from "./vault.js";

function fastPasswordKeystore(password: string) {
  return passwordKeystoreWithParams({
    password,
    iterations: 1,
    memory_kib: 64,
    parallelism: 1
  });
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-vault-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("BuyerVault init/open", () => {
  it("initializes an encrypted UUID-bound vault and opens it with the stored key", async () => {
    await withTempRoot(async (root) => {
      const vaultPath = join(root, "vault.box");
      const keystore = memoryKeystore();
      const boxStore = memoryBoxStore();
      const vault = await BuyerVault.init({
        path: vaultPath,
        profile: { name: "Jane Doe", email: "jane@example.com" },
        keystore,
        boxStore
      });

      expect(vault.path).toBe(vaultPath);
      expect(vault.ledgerPath).toBe(join(root, "ledger.box"));
      expect(vault.legacyLedgerPath).toBe(join(root, "spend-ledger.jsonl"));
      expect(vault.profile).toEqual({ name: "Jane Doe", email: "jane@example.com" });
      expect(await keystore.getMasterKey(VAULT_KEY_SERVICE, accountForVault(vault.uuid))).toHaveLength(32);

      const rawBox = await boxStore.read("vault.box");
      expect(rawBox).toBeTruthy();
      expect(Buffer.from(rawBox!).includes(Buffer.from("Jane Doe"))).toBe(false);

      const reopened = await BuyerVault.open({ path: vaultPath, keystore, boxStore });
      expect(reopened.uuid).toBe(vault.uuid);
      expect(reopened.profile).toEqual(vault.profile);
    });
  });

  it("opens after the vault file moves because the key account is UUID-derived", async () => {
    await withTempRoot(async (root) => {
      const originalPath = join(root, "original.box");
      const movedPath = join(root, "moved.box");
      const keystore = memoryKeystore();
      const boxStore = memoryBoxStore();
      const vault = await BuyerVault.init({
        path: originalPath,
        profile: { name: "Moved Vault" },
        keystore,
        boxStore
      });
      const rawBox = await boxStore.read("original.box");
      await boxStore.write("moved.box", rawBox!);
      await boxStore.delete("original.box");

      const moved = await BuyerVault.open({ path: movedPath, keystore, boxStore });
      expect(moved.uuid).toBe(vault.uuid);
      expect(moved.path).toBe(movedPath);
      expect(moved.profile.name).toBe("Moved Vault");
    });
  });

  it("initializes and opens a password-derived vault without writing a keychain entry", async () => {
    await withTempRoot(async (root) => {
      const vaultPath = join(root, "password.box");
      const boxStore = memoryBoxStore();
      const vault = await BuyerVault.init({
        path: vaultPath,
        profile: { name: "Password Vault" },
        keystore: fastPasswordKeystore("correct horse battery staple"),
        boxStore
      });

      const rawBox = await boxStore.read("password.box");
      const header = JSON.parse(new TextDecoder().decode(unpackVaultBox(rawBox!).header));
      expect(header.kdf).toMatchObject({
        type: "argon2id",
        iterations: 1,
        memory_kib: 64,
        parallelism: 1
      });
      expect(header.kdf.salt).toEqual(expect.any(String));

      const reopened = await BuyerVault.open({
        path: vaultPath,
        keystore: fastPasswordKeystore("correct horse battery staple"),
        boxStore
      });
      expect(reopened.uuid).toBe(vault.uuid);
      expect(reopened.profile.name).toBe("Password Vault");

      await expect(
        BuyerVault.open({
          path: vaultPath,
          keystore: fastPasswordKeystore("wrong password"),
          boxStore
        })
      ).rejects.toThrow();
    });
  });

  it("rejects opening password and OS-backed vaults with the wrong keystore kind", async () => {
    await withTempRoot(async (root) => {
      const passwordBoxStore = memoryBoxStore();
      await BuyerVault.init({
        path: join(root, "password.box"),
        profile: { name: "Password Vault" },
        keystore: fastPasswordKeystore("vault password"),
        boxStore: passwordBoxStore
      });
      await expect(
        BuyerVault.open({
          path: join(root, "password.box"),
          keystore: memoryKeystore(),
          boxStore: passwordBoxStore
        })
      ).rejects.toThrow(/password keystore required for kdf-backed vault/);

      const osLikeBoxStore = memoryBoxStore();
      await BuyerVault.init({
        path: join(root, "os.box"),
        profile: { name: "OS Vault" },
        keystore: memoryKeystore(),
        boxStore: osLikeBoxStore
      });
      await expect(
        BuyerVault.open({
          path: join(root, "os.box"),
          keystore: passwordKeystore({ password: "vault password" }),
          boxStore: osLikeBoxStore
        })
      ).rejects.toThrow(/this vault was inited with a different keystore/);
    });
  });

  it("refuses existing vaults and missing keys", async () => {
    await withTempRoot(async (root) => {
      const vaultPath = join(root, "vault.box");
      const boxStore = memoryBoxStore();
      const keystore = memoryKeystore();
      await BuyerVault.init({ path: vaultPath, profile: { name: "A" }, keystore, boxStore });

      await expect(
        BuyerVault.init({ path: vaultPath, profile: { name: "B" }, keystore, boxStore })
      ).rejects.toThrow(/already exists/);
      await expect(
        BuyerVault.open({ path: vaultPath, keystore: memoryKeystore(), boxStore })
      ).rejects.toThrow(/vault key not found/);
    });
  });

  it("rolls back the key when writing the encrypted box fails", async () => {
    await withTempRoot(async (root) => {
      const backingKeystore = memoryKeystore();
      const setAccounts: string[] = [];
      const deletedAccounts: string[] = [];
      const keystore = {
        async getMasterKey(service: string, account: string) {
          return backingKeystore.getMasterKey(service, account);
        },
        async setMasterKey(service: string, account: string, key: Uint8Array) {
          setAccounts.push(account);
          await backingKeystore.setMasterKey(service, account, key);
        },
        async deleteMasterKey(service: string, account: string) {
          deletedAccounts.push(account);
          await backingKeystore.deleteMasterKey(service, account);
        }
      };
      const failingBoxStore = {
        read: async () => null,
        write: async () => {
          throw new Error("disk full");
        },
        delete: async () => undefined
      };

      await expect(
        BuyerVault.init({
          path: join(root, "vault.box"),
          profile: { name: "Rollback" },
          keystore,
          boxStore: failingBoxStore
        })
      ).rejects.toThrow(/disk full/);

      expect(setAccounts).toHaveLength(1);
      expect(deletedAccounts).toEqual(setAccounts);
      await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, setAccounts[0]!)).resolves.toBeNull();
    });
  });

  it("zeros the in-memory key on close and rejects profile reads afterward", async () => {
    await withTempRoot(async (root) => {
      const vault = await BuyerVault.init({
        path: join(root, "vault.box"),
        profile: { name: "Close Me" },
        keystore: memoryKeystore(),
        boxStore: memoryBoxStore()
      });

      await vault.close();
      expect(vault.isOpen).toBe(false);
      await expect(vault.close()).resolves.toBeUndefined();
      expect(() => vault.profile).toThrow(/vault is closed/);
    });
  });
});
