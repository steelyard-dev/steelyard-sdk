import { ecdsaVerifyRaw } from "@steelyard/core";
import { describe, expect, it } from "vitest";
import { BuyerVault, memoryBoxStore, memoryKeystore } from "./index.js";
import {
  createStoredUcpSigningKey,
  normalizeStoredUcpSigningKey,
  signWithUcpKey,
  ucpSigningKeyMetadata,
  ucpSigningPublicKey
} from "./ucp-signing.js";

describe("vault UCP signing keys", () => {
  it("normalizes stored EC keys and exposes cloned public metadata", async () => {
    const key = createStoredUcpSigningKey({ algorithm: "ES256" }, new Date("2026-06-14T12:00:00.000Z"));
    const normalized = normalizeStoredUcpSigningKey(key);
    const data = new TextEncoder().encode("signature base");
    const signature = await signWithUcpKey(key, { algorithm: "ES256", data });

    expect(normalized).toEqual(key);
    expect(normalized).not.toBe(key);
    expect(ucpSigningKeyMetadata(key)).toEqual({ kid: key.kid });
    expect(ucpSigningPublicKey(key)).toEqual(key.public_jwk);
    expect(ucpSigningPublicKey(key)).not.toBe(key.public_jwk);
    expect(ucpSigningPublicKey(key)).not.toHaveProperty("d");
    await expect(ecdsaVerifyRaw({
      algorithm: "ES256",
      publicKeyJwk: key.public_jwk,
      data,
      signature
    })).resolves.toBe(true);
    await expect(signWithUcpKey(key, { algorithm: "ES384", data })).rejects.toThrow(/ES256/);
  });

  it("rejects malformed stored key records", () => {
    const valid = createStoredUcpSigningKey({ algorithm: "ES384" }, new Date("2026-06-14T12:00:00.000Z"));

    expect(normalizeStoredUcpSigningKey(undefined)).toBeUndefined();
    expect(() => normalizeStoredUcpSigningKey(null)).toThrow(/malformed/);
    expect(() => normalizeStoredUcpSigningKey({ ...valid, algorithm: "EdDSA" })).toThrow(/algorithm/);
    expect(() => normalizeStoredUcpSigningKey({ ...valid, kid: "" })).toThrow(/id/);
    expect(() => normalizeStoredUcpSigningKey({ ...valid, public_jwk: { ...valid.public_jwk, d: "secret" } }))
      .toThrow(/private d/);
    expect(() => normalizeStoredUcpSigningKey({ ...valid, private_jwk: null })).toThrow(/EC JWK/);
    expect(() => normalizeStoredUcpSigningKey({ ...valid, created_at: "not-a-date" })).toThrow(/creation timestamp/);
  });

  it("persists the AP2-prep holder key in the encrypted vault", async () => {
    const boxStore = memoryBoxStore();
    const keystore = memoryKeystore();
    const vault = await BuyerVault.init({
      path: "/tmp/vault.box",
      profile: { name: "Jane Doe" },
      keystore,
      boxStore
    });

    await expect(vault.hasUcpSigningKey()).resolves.toBe(false);
    const created = await vault.createUcpSigningKey({ algorithm: "ES256" });
    await expect(vault.createUcpSigningKey({ algorithm: "ES256" })).resolves.toEqual(created);
    await expect(vault.createUcpSigningKey({ algorithm: "ES384" })).rejects.toThrow(/already exists/);
    const publicKey = await vault.exportUcpSigningPublicKey();
    expect(publicKey.kid).toBe(created.kid);
    expect(publicKey).not.toHaveProperty("d");
    expect(Buffer.from((await boxStore.read("vault.box"))!).includes(Buffer.from(String(publicKey.x)))).toBe(false);

    const reopened = await BuyerVault.open({ path: "/tmp/vault.box", keystore, boxStore });
    await expect(reopened.hasUcpSigningKey()).resolves.toBe(true);
    await expect(reopened.exportUcpSigningPublicKey()).resolves.toEqual(publicKey);
    const data = new TextEncoder().encode("vault signature base");
    const signature = await reopened.signWithUcpKey({ algorithm: "ES256", data });
    await expect(ecdsaVerifyRaw({ algorithm: "ES256", publicKeyJwk: publicKey, data, signature })).resolves.toBe(true);
  });

  it("throws before exporting or signing without a holder key", async () => {
    const vault = await BuyerVault.init({
      path: "/tmp/vault.box",
      profile: { name: "Jane Doe" },
      keystore: memoryKeystore(),
      boxStore: memoryBoxStore()
    });
    await expect(vault.exportUcpSigningPublicKey()).rejects.toThrow(/UCP signing key is not configured/);
    await expect(vault.signWithUcpKey({ algorithm: "ES256", data: new Uint8Array([1]) }))
      .rejects.toThrow(/UCP signing key is not configured/);
  });
});
