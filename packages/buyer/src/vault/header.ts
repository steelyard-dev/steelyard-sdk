import { randomUUID } from "node:crypto";

export interface VaultHeader {
  version: 1;
  uuid: string;
  alg: "xsalsa20-poly1305";
  kdf: null | {
    type: "argon2id";
    salt: string;
    iterations: number;
    memory_kib: number;
    parallelism: number;
  };
}

export function createVaultHeader(opts: { kdf?: VaultHeader["kdf"] } = {}): VaultHeader {
  return {
    version: 1,
    uuid: randomUUID(),
    alg: "xsalsa20-poly1305",
    kdf: opts.kdf ?? null
  };
}

export function encodeVaultHeader(header: VaultHeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(header));
}
