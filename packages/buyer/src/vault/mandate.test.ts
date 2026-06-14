import { describe, expect, it } from "vitest";
import {
  createStoredMandateKey,
  mandateKeyMetadata,
  mandatePublicKey,
  normalizeStoredMandateKey,
  pairwiseSubject,
  signMandateJwt
} from "./mandate.js";

describe("vault mandate keys", () => {
  it("normalizes stored keys and exposes cloned public metadata", () => {
    const key = createStoredMandateKey(new Date("2026-06-14T12:00:00.000Z"));
    const normalized = normalizeStoredMandateKey(key);

    expect(normalized).toEqual(key);
    expect(normalized).not.toBe(key);
    expect(mandateKeyMetadata(key)).toEqual({ key_id: key.key_id, algorithm: "Ed25519" });
    expect(mandatePublicKey(key)).toEqual({ jwk: key.public_jwk, key_id: key.key_id });
    expect(mandatePublicKey(key).jwk).not.toBe(key.public_jwk);
    expect(pairwiseSubject(key, "https://merchant.example/.well-known/ucp")).not.toContain("@");

    const signed = signMandateJwt(key, { sub: "buyer", aud: "merchant" });
    expect(signed.key_id).toBe(key.key_id);
    expect(signed.jwt.split(".")).toHaveLength(3);
  });

  it("rejects malformed stored key records", () => {
    const valid = createStoredMandateKey(new Date("2026-06-14T12:00:00.000Z"));

    expect(normalizeStoredMandateKey(undefined)).toBeUndefined();
    expect(() => normalizeStoredMandateKey(null)).toThrow(/malformed/);
    expect(() => normalizeStoredMandateKey({ ...valid, algorithm: "P-256" })).toThrow(/algorithm/);
    expect(() => normalizeStoredMandateKey({ ...valid, key_id: "" })).toThrow(/id/);
    expect(() => normalizeStoredMandateKey({ ...valid, public_jwk: null })).toThrow(/public key/);
    expect(() => normalizeStoredMandateKey({ ...valid, private_jwk: null })).toThrow(/private key/);
    expect(() => normalizeStoredMandateKey({ ...valid, pairwise_secret_b64: "" })).toThrow(/pairwise secret/);
    expect(() => normalizeStoredMandateKey({ ...valid, created_at: "not-a-date" })).toThrow(/creation timestamp/);
  });
});
