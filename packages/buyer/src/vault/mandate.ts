import { systemClock, type JsonWebKey } from "@steelyard-dev/core";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";
import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign
} from "node:crypto";

export interface StoredMandateKey {
  algorithm: "Ed25519";
  key_id: string;
  public_jwk: JsonWebKey;
  private_jwk: JsonWebKey;
  pairwise_secret_b64: string;
  created_at: string;
}

export interface MandateKeyMetadata {
  key_id: string;
  algorithm: "Ed25519";
}

export class MandateKeyMissing extends Error {
  readonly hint = "call wallet.createMandateKey() to enable UCP purchases" as const;

  constructor() {
    super("mandate key is not configured");
    this.name = "MandateKeyMissing";
  }
}

export function createStoredMandateKey(at = systemClock()): StoredMandateKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  return {
    algorithm: "Ed25519",
    key_id: mandateKeyId(publicJwk),
    public_jwk: publicJwk,
    private_jwk: privateJwk,
    pairwise_secret_b64: randomBytes(32).toString("base64url"),
    created_at: at.toISOString()
  };
}

export function normalizeStoredMandateKey(value: unknown): StoredMandateKey | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("vault mandate key is malformed");
  const key = value as Partial<StoredMandateKey>;
  if (key.algorithm !== "Ed25519") throw new Error("vault mandate key algorithm is unsupported");
  if (typeof key.key_id !== "string" || !key.key_id) throw new Error("vault mandate key id is malformed");
  if (!isJwk(key.public_jwk)) throw new Error("vault mandate public key is malformed");
  if (!isJwk(key.private_jwk)) throw new Error("vault mandate private key is malformed");
  if (typeof key.pairwise_secret_b64 !== "string" || !key.pairwise_secret_b64) {
    throw new Error("vault mandate pairwise secret is malformed");
  }
  if (typeof key.created_at !== "string" || Number.isNaN(new Date(key.created_at).getTime())) {
    throw new Error("vault mandate creation timestamp is malformed");
  }
  return {
    algorithm: "Ed25519",
    key_id: key.key_id,
    public_jwk: cloneJwk(key.public_jwk),
    private_jwk: cloneJwk(key.private_jwk),
    pairwise_secret_b64: key.pairwise_secret_b64,
    created_at: new Date(key.created_at).toISOString()
  };
}

export function mandateKeyMetadata(key: StoredMandateKey): MandateKeyMetadata {
  return { key_id: key.key_id, algorithm: key.algorithm };
}

export function mandatePublicKey(key: StoredMandateKey): { jwk: JsonWebKey; key_id: string } {
  return { jwk: cloneJwk(key.public_jwk), key_id: key.key_id };
}

export function signMandateJwt(key: StoredMandateKey, payload: object): { jwt: string; key_id: string } {
  const header = base64urlJson({ alg: "EdDSA", typ: "JWT", kid: key.key_id });
  const body = base64urlJson(payload);
  const signingInput = `${header}.${body}`;
  const privateKey = createPrivateKey({ key: key.private_jwk as NodeJsonWebKey, format: "jwk" });
  const signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  return { jwt: `${signingInput}.${signature}`, key_id: key.key_id };
}

export function pairwiseSubject(key: StoredMandateKey, audience: string): string {
  return createHmac("sha256", Buffer.from(key.pairwise_secret_b64, "base64url"))
    .update(audience)
    .digest("base64url");
}

function mandateKeyId(publicJwk: JsonWebKey): string {
  const thumbprint = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x
  };
  return `mk_${createHash("sha256").update(JSON.stringify(thumbprint)).digest("base64url").slice(0, 32)}`;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function isJwk(value: unknown): value is JsonWebKey {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJwk(value: JsonWebKey): JsonWebKey {
  return JSON.parse(JSON.stringify(value)) as JsonWebKey;
}
