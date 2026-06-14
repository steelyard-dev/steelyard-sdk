import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileBoxStore, memoryBoxStore } from "./boxstore.js";
import { openVaultBox, sealVaultBox, VAULT_KEY_BYTES, VAULT_NONCE_BYTES } from "./crypto.js";
import { createVaultHeader } from "./header.js";
import { memoryKeystore, VAULT_KEY_SERVICE } from "./keystore.js";

describe("vault crypto box", () => {
  it("round-trips a payload with XSalsa20-Poly1305 and authenticates the header", () => {
    const key = bytes(VAULT_KEY_BYTES, 7);
    const nonce = bytes(VAULT_NONCE_BYTES, 3);
    const header = createVaultHeader();
    const plaintext = new TextEncoder().encode(JSON.stringify({ cards: [{ last4: "4242" }] }));

    const sealed = sealVaultBox({ key, nonce, header, plaintext });
    expect(Buffer.from(sealed.ciphertext).includes(Buffer.from("4242"))).toBe(false);

    const opened = openVaultBox({ key, nonce: sealed.nonce, header, ciphertext: sealed.ciphertext });
    expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(plaintext));

    expect(() =>
      openVaultBox({
        key,
        nonce: sealed.nonce,
        header: { ...header, uuid: "00000000-0000-4000-8000-000000000000" },
        ciphertext: sealed.ciphertext
      })
    ).toThrow(/header authentication/);
  });

  it("rejects tampered ciphertext", () => {
    const key = bytes(VAULT_KEY_BYTES, 1);
    const header = createVaultHeader();
    const sealed = sealVaultBox({ key, header, plaintext: new Uint8Array([1, 2, 3]) });
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 1;

    expect(() => openVaultBox({ key, nonce: sealed.nonce, header, ciphertext: sealed.ciphertext })).toThrow();
  });
});

describe("vault stores", () => {
  it("memoryKeystore copies keys on set and get", async () => {
    const keystore = memoryKeystore();
    const key = bytes(VAULT_KEY_BYTES, 9);
    await keystore.setMasterKey(VAULT_KEY_SERVICE, "acct", key);
    key.fill(0);

    const stored = await keystore.getMasterKey(VAULT_KEY_SERVICE, "acct");
    expect(stored?.[0]).toBe(9);
    stored?.fill(1);
    expect((await keystore.getMasterKey(VAULT_KEY_SERVICE, "acct"))?.[0]).toBe(9);

    await keystore.deleteMasterKey(VAULT_KEY_SERVICE, "acct");
    await expect(keystore.getMasterKey(VAULT_KEY_SERVICE, "acct")).resolves.toBeNull();
  });

  it("memoryBoxStore copies boxes on write and read", async () => {
    const store = memoryBoxStore();
    const data = new Uint8Array([1, 2, 3]);
    await store.write("vault.box", data);
    data.fill(0);

    const stored = await store.read("vault.box");
    expect(Array.from(stored ?? [])).toEqual([1, 2, 3]);
    stored?.fill(9);
    expect(Array.from((await store.read("vault.box")) ?? [])).toEqual([1, 2, 3]);

    await store.delete("vault.box");
    await expect(store.read("vault.box")).resolves.toBeNull();
  });

  it("fileBoxStore writes atomically with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-vault-"));
    const store = fileBoxStore(root);

    await expect(store.read("vault.box")).resolves.toBeNull();
    await store.write("vault.box", new Uint8Array([4, 5, 6]));

    expect(Array.from((await store.read("vault.box")) ?? [])).toEqual([4, 5, 6]);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "vault.box"))).mode & 0o777).toBe(0o600);
    await expect(store.write("../vault.box", new Uint8Array())).rejects.toThrow(/invalid box name/);

    await store.delete("vault.box");
    await expect(store.read("vault.box")).resolves.toBeNull();
  });
});

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(Array.from({ length }, () => value));
}
