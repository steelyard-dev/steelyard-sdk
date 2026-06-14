import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { randomBytes } from "node:crypto";
import { encodeVaultHeader, type VaultHeader } from "./header.js";

export const VAULT_KEY_BYTES = 32;
export const VAULT_NONCE_BYTES = 24;

export interface SealedVaultBox {
  nonce: Uint8Array;
  header: Uint8Array;
  ciphertext: Uint8Array;
}

export function sealVaultBox(opts: {
  key: Uint8Array;
  header: VaultHeader;
  plaintext: Uint8Array;
  nonce?: Uint8Array;
}): SealedVaultBox {
  assertLength("key", opts.key, VAULT_KEY_BYTES);
  const nonce = opts.nonce ? new Uint8Array(opts.nonce) : new Uint8Array(randomBytes(VAULT_NONCE_BYTES));
  assertLength("nonce", nonce, VAULT_NONCE_BYTES);
  const header = encodeVaultHeader(opts.header);
  const payload = authenticatedPayload(header, opts.plaintext);
  const ciphertext = xsalsa20poly1305(opts.key, nonce).encrypt(payload);
  return { nonce, header, ciphertext };
}

export function openVaultBox(opts: {
  key: Uint8Array;
  header: VaultHeader;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  assertLength("key", opts.key, VAULT_KEY_BYTES);
  assertLength("nonce", opts.nonce, VAULT_NONCE_BYTES);
  const expectedHeader = encodeVaultHeader(opts.header);
  const payload = xsalsa20poly1305(opts.key, opts.nonce).decrypt(opts.ciphertext);
  const { header, plaintext } = splitAuthenticatedPayload(payload);
  if (!bytesEqual(header, expectedHeader)) {
    throw new Error("vault header authentication failed");
  }
  return plaintext;
}

function authenticatedPayload(header: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, false);
  const out = new Uint8Array(len.length + header.length + plaintext.length);
  out.set(len, 0);
  out.set(header, len.length);
  out.set(plaintext, len.length + header.length);
  return out;
}

function splitAuthenticatedPayload(payload: Uint8Array): { header: Uint8Array; plaintext: Uint8Array } {
  if (payload.length < 4) throw new Error("vault payload is malformed");
  const headerLength = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
  const headerStart = 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > payload.length) throw new Error("vault payload header is malformed");
  return {
    header: payload.slice(headerStart, headerEnd),
    plaintext: payload.slice(headerEnd)
  };
}

function assertLength(name: string, bytes: Uint8Array, expected: number): void {
  if (bytes.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}
