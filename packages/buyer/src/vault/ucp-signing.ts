import {
  assertValidEcJwk,
  ecdsaSignRaw,
  systemClock,
  type EcJwk,
  type HmsAlgorithm
} from "@steelyard-dev/core";
import { createHash, generateKeyPairSync, type JsonWebKey as NodeJsonWebKey } from "node:crypto";

export interface StoredUcpSigningKey {
  algorithm: HmsAlgorithm;
  kid: string;
  public_jwk: EcJwk;
  private_jwk: EcJwk;
  created_at: string;
}

export interface UcpSigningKeyMetadata {
  kid: string;
}

export class UcpSigningKeyMissing extends Error {
  readonly hint = "call wallet.createUcpSigningKey({ algorithm }) to enable HMS UCP requests" as const;

  constructor() {
    super("UCP signing key is not configured");
    this.name = "UcpSigningKeyMissing";
  }
}

export function createStoredUcpSigningKey(
  opts: { algorithm: HmsAlgorithm },
  at = systemClock()
): StoredUcpSigningKey {
  const curve = opts.algorithm === "ES256" ? "P-256" : "P-384";
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: curve });
  const publicBase = publicKey.export({ format: "jwk" }) as NodeJsonWebKey;
  const privateBase = privateKey.export({ format: "jwk" }) as NodeJsonWebKey;
  const kid = ucpSigningKeyId(publicBase);
  const publicJwk = assertValidEcJwk({
    ...publicBase,
    kid,
    use: "sig",
    alg: opts.algorithm
  });
  const privateJwk = assertValidEcJwk({
    ...privateBase,
    kid,
    use: "sig",
    alg: opts.algorithm
  }, { allowPrivate: true });

  return {
    algorithm: opts.algorithm,
    kid,
    public_jwk: publicJwk,
    private_jwk: privateJwk,
    created_at: at.toISOString()
  };
}

export function normalizeStoredUcpSigningKey(value: unknown): StoredUcpSigningKey | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("vault UCP signing key is malformed");
  const key = value as Partial<StoredUcpSigningKey>;
  if (key.algorithm !== "ES256" && key.algorithm !== "ES384") {
    throw new Error("vault UCP signing key algorithm is unsupported");
  }
  if (typeof key.kid !== "string" || !key.kid) throw new Error("vault UCP signing key id is malformed");
  const publicJwk = assertValidEcJwk(key.public_jwk);
  const privateJwk = assertValidEcJwk(key.private_jwk, { allowPrivate: true });
  if (publicJwk.kid !== key.kid || privateJwk.kid !== key.kid) {
    throw new Error("vault UCP signing key kid mismatch");
  }
  if (publicJwk.alg !== key.algorithm || privateJwk.alg !== key.algorithm) {
    throw new Error("vault UCP signing key algorithm mismatch");
  }
  if (typeof key.created_at !== "string" || Number.isNaN(new Date(key.created_at).getTime())) {
    throw new Error("vault UCP signing key creation timestamp is malformed");
  }
  return {
    algorithm: key.algorithm,
    kid: key.kid,
    public_jwk: cloneJwk(publicJwk),
    private_jwk: cloneJwk(privateJwk),
    created_at: new Date(key.created_at).toISOString()
  };
}

export function ucpSigningKeyMetadata(key: StoredUcpSigningKey): UcpSigningKeyMetadata {
  return { kid: key.kid };
}

export function ucpSigningPublicKey(key: StoredUcpSigningKey): EcJwk {
  return cloneJwk(key.public_jwk);
}

export async function signWithUcpKey(
  key: StoredUcpSigningKey,
  args: { data: Uint8Array; algorithm: HmsAlgorithm }
): Promise<Uint8Array> {
  if (args.algorithm !== key.algorithm) {
    throw new Error(`UCP signing key ${key.kid} uses ${key.algorithm}, not ${args.algorithm}`);
  }
  return await ecdsaSignRaw({
    algorithm: args.algorithm,
    privateKeyJwk: key.private_jwk,
    data: args.data
  });
}

function ucpSigningKeyId(publicJwk: NodeJsonWebKey): string {
  const thumbprint = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y
  };
  return `uk_${createHash("sha256").update(JSON.stringify(thumbprint)).digest("base64url").slice(0, 32)}`;
}

function cloneJwk(value: EcJwk): EcJwk {
  return JSON.parse(JSON.stringify(value)) as EcJwk;
}
