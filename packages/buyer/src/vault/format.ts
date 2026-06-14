import { VAULT_NONCE_BYTES, type SealedVaultBox } from "./crypto.js";

const HEADER_LENGTH_BYTES = 4;

export function packVaultBox(box: SealedVaultBox): Uint8Array {
  const headerLength = new Uint8Array(HEADER_LENGTH_BYTES);
  new DataView(headerLength.buffer).setUint32(0, box.header.length, false);
  const out = new Uint8Array(
    box.nonce.length + headerLength.length + box.header.length + box.ciphertext.length
  );
  let offset = 0;
  out.set(box.nonce, offset);
  offset += box.nonce.length;
  out.set(headerLength, offset);
  offset += headerLength.length;
  out.set(box.header, offset);
  offset += box.header.length;
  out.set(box.ciphertext, offset);
  return out;
}

export function unpackVaultBox(bytes: Uint8Array): SealedVaultBox {
  if (bytes.length < VAULT_NONCE_BYTES + HEADER_LENGTH_BYTES) {
    throw new Error("vault box is malformed");
  }
  const nonce = bytes.slice(0, VAULT_NONCE_BYTES);
  const lengthOffset = VAULT_NONCE_BYTES;
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset + lengthOffset, HEADER_LENGTH_BYTES)
    .getUint32(0, false);
  const headerStart = lengthOffset + HEADER_LENGTH_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.length) throw new Error("vault box header is malformed");
  return {
    nonce,
    header: bytes.slice(headerStart, headerEnd),
    ciphertext: bytes.slice(headerEnd)
  };
}
