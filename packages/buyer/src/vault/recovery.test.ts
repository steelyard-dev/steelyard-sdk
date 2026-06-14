import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keyringState = vi.hoisted(() => ({
  secrets: new Map<string, Uint8Array>()
}));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class MockAsyncEntry {
    readonly #key: string;

    constructor(service: string, account: string) {
      this.#key = `${service}\0${account}`;
    }

    async getSecret(): Promise<Uint8Array | undefined> {
      const secret = keyringState.secrets.get(this.#key);
      return secret ? new Uint8Array(secret) : undefined;
    }

    async setSecret(secret: Uint8Array): Promise<void> {
      keyringState.secrets.set(this.#key, new Uint8Array(secret));
    }

    async deleteCredential(): Promise<boolean> {
      keyringState.secrets.delete(this.#key);
      return true;
    }
  }
}));

const vaultModule = await import("./index.js");
const recoveryModule = await import("./recovery.js");
const vaultInternals = await import("./vault.js");
const keystoreInternals = await import("./keystore.js");
const { BuyerVault, memoryKeystore } = vaultModule;
const { _resetRecoveryWarningForTests } = recoveryModule;
const { accountForVault } = vaultInternals;
const { VAULT_KEY_SERVICE } = keystoreInternals;

async function withTemp<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-recovery-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("BuyerVault recovery", () => {
  beforeEach(() => {
    keyringState.secrets.clear();
    _resetRecoveryWarningForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports a password-wrapped recovery file and imports the key into the OS keychain", async () => {
    await withTemp(async (root) => {
      const vaultPath = join(root, "vault.box");
      const recoveryPath = join(root, "recovery.enc");
      const vault = await BuyerVault.init({
        path: vaultPath,
        profile: { name: "Recovery User" },
        keystore: memoryKeystore()
      });
      const card = await vault.addCard({
        id: "personal",
        name_on_card: "Recovery User",
        pan: "4111111111111111",
        exp: "12/99",
        tags: ["default"]
      });
      const unsafeKey = await vault.exportKey_UNSAFE();

      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await expect(
        vault.exportKeyToFile({ path: recoveryPath, recoveryPassword: "recovery password" })
      ).resolves.toBe(recoveryPath);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toContain(recoveryPath);

      const fileMode = (await stat(recoveryPath)).mode & 0o777;
      expect(fileMode).toBe(0o600);
      const recoveryJson = JSON.parse(await readFile(recoveryPath, "utf8"));
      expect(recoveryJson).toMatchObject({
        version: 1,
        vault_uuid: vault.uuid,
        kdf: { type: "argon2id", iterations: 3, memory_kib: 65_536, parallelism: 4 }
      });
      expect(recoveryJson.wrapped_key).toEqual(expect.any(String));
      expect(await readFile(recoveryPath, "utf8")).not.toContain(unsafeKey);

      await expect(
        vault.exportKeyToFile({ path: recoveryPath, recoveryPassword: "recovery password" })
      ).rejects.toThrow(/already exists/);
      await expect(
        BuyerVault.importKeyFromFile({
          path: recoveryPath,
          vaultPath,
          recoveryPassword: "wrong password"
        })
      ).rejects.toThrow();

      await BuyerVault.importKeyFromFile({
        path: recoveryPath,
        vaultPath,
        recoveryPassword: "recovery password"
      });
      const account = accountForVault(vault.uuid);
      expect(keyringState.secrets.get(`${VAULT_KEY_SERVICE}\0${account}`)).toHaveLength(32);
      await expect(
        BuyerVault.importKeyFromFile({
          path: recoveryPath,
          vaultPath,
          recoveryPassword: "recovery password"
        })
      ).rejects.toThrow(/already installed/);

      const reopened = await BuyerVault.open({ path: vaultPath });
      await expect(reopened.revealCard(card.id)).resolves.toMatchObject({ pan: "4111111111111111" });
    });
  }, 30_000);

  it("rejects recovery files for a different vault UUID", async () => {
    await withTemp(async (root) => {
      const firstVaultPath = join(root, "first.box");
      const secondVaultPath = join(root, "second.box");
      const recoveryPath = join(root, "first-recovery.enc");
      const first = await BuyerVault.init({
        path: firstVaultPath,
        profile: { name: "First" },
        keystore: memoryKeystore()
      });
      await BuyerVault.init({
        path: secondVaultPath,
        profile: { name: "Second" },
        keystore: memoryKeystore()
      });

      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await first.exportKeyToFile({ path: recoveryPath, recoveryPassword: "recovery password" });
      await expect(
        BuyerVault.importKeyFromFile({
          path: recoveryPath,
          vaultPath: secondVaultPath,
          recoveryPassword: "recovery password"
        })
      ).rejects.toThrow(/does not match vault uuid/);
    });
  }, 15_000);

  it("rejects malformed recovery files and recovery calls after close", async () => {
    await withTemp(async (root) => {
      const vaultPath = join(root, "vault.box");
      const recoveryPath = join(root, "bad-recovery.enc");
      await writeFile(recoveryPath, JSON.stringify({ version: 1, vault_uuid: "x" }), { mode: 0o600 });
      await expect(
        BuyerVault.importKeyFromFile({
          path: recoveryPath,
          vaultPath,
          recoveryPassword: "recovery password"
        })
      ).rejects.toThrow(/recovery kdf/);

      const vault = await BuyerVault.init({
        path: vaultPath,
        profile: { name: "Closed" },
        keystore: memoryKeystore()
      });
      await vault.close();
      await expect(vault.exportKey_UNSAFE()).rejects.toThrow(/vault is closed/);
      await expect(
        vault.exportKeyToFile({ path: join(root, "closed.enc"), recoveryPassword: "pw" })
      ).rejects.toThrow(/vault is closed/);
    });
  });
});
