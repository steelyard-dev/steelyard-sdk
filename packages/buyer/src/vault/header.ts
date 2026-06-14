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

export function parseVaultHeader(bytes: Uint8Array): VaultHeader {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as VaultHeader;
  if (
    parsed.version !== 1 ||
    parsed.alg !== "xsalsa20-poly1305" ||
    typeof parsed.uuid !== "string" ||
    !validKdf(parsed.kdf)
  ) {
    throw new Error("vault header is unsupported");
  }
  return parsed;
}

function validKdf(kdf: VaultHeader["kdf"]): boolean {
  if (kdf === null) return true;
  return (
    typeof kdf === "object" &&
    kdf.type === "argon2id" &&
    typeof kdf.salt === "string" &&
    Number.isInteger(kdf.iterations) &&
    kdf.iterations > 0 &&
    Number.isInteger(kdf.memory_kib) &&
    kdf.memory_kib > 0 &&
    Number.isInteger(kdf.parallelism) &&
    kdf.parallelism > 0
  );
}
