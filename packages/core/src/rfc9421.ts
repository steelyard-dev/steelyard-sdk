// Copyright (c) Steelyard contributors. MIT License.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type JsonWebKey as NodeJsonWebKey
} from "node:crypto";
import canonicalize from "canonicalize";

export type HmsAlgorithm = "ES256" | "ES384";

export interface EcJwk {
  kid?: string;
  kty: "EC";
  crv: "P-256" | "P-384";
  x: string;
  y: string;
  d?: string;
  use?: "sig" | string;
  alg?: HmsAlgorithm;
  [key: string]: unknown;
}

export interface SignatureParameters {
  keyid: string;
  created?: number;
  expires?: number;
  nonce?: string;
}

export interface BuildSignatureBaseArgs {
  method?: string;
  authority?: string;
  path?: string;
  query?: string;
  status?: number;
  headers: Record<string, string>;
  components: string[];
  parameters: SignatureParameters;
}

export interface Sf941Token {
  kind: "token";
  value: string;
}

export type Sf941BareItem = string | number | boolean | Uint8Array | Sf941Token;

export interface Sf941Item {
  value: Sf941BareItem;
  params?: Record<string, Sf941BareItem>;
}

export interface Sf941InnerList {
  kind: "inner-list";
  value: Sf941Item[];
  params?: Record<string, Sf941BareItem>;
}

export type Sf941DictMember = Sf941Item | Sf941InnerList;
export type Sf941Dict = Record<string, Sf941DictMember>;

interface AlgorithmSpec {
  hash: "sha256" | "sha384";
  curve: "P-256" | "P-384";
  width: 64 | 96;
}

const ALGORITHMS: Record<HmsAlgorithm, AlgorithmSpec> = {
  ES256: { hash: "sha256", curve: "P-256", width: 64 },
  ES384: { hash: "sha384", curve: "P-384", width: 96 }
};

const SF_KEY = /^[a-z*][a-z0-9_.*-]*$/;
const SF_TOKEN = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*$/;

export function buildSignatureBase(args: BuildSignatureBaseArgs): Uint8Array {
  const headers = lowerCaseHeaders(args.headers);
  const lines = args.components.map((component) => {
    const identifier = parseComponentIdentifier(component);
    const value = componentValue(identifier.name, args, headers);
    return `${formatComponentIdentifier(identifier)}: ${value}`;
  });
  lines.push(`"@signature-params": ${signatureParamsValue(args.components, args.parameters)}`);
  return Buffer.from(lines.join("\n"), "utf8");
}

export function normalizeAuthority(url: URL): string {
  const host = url.hostname.toLowerCase();
  const defaultPort = url.protocol === "http:" ? "80" : url.protocol === "https:" ? "443" : "";
  if (!url.port || url.port === defaultPort) return host;
  return `${host}:${url.port}`;
}

export function contentDigestHeader(args: {
  body: Uint8Array;
  algorithm?: "sha-256" | "sha-512";
}): string {
  const algorithm = args.algorithm ?? "sha-256";
  const hashName = algorithm === "sha-256" ? "sha256" : "sha512";
  const digest = createHash(hashName).update(args.body).digest("base64");
  return `${algorithm}=:${digest}:`;
}

export function parseSf941Dict(value: string): Sf941Dict {
  const parser = new SfParser(value);
  const dict: Sf941Dict = {};
  parser.skipOwsp();
  if (parser.done()) return dict;

  while (!parser.done()) {
    const key = parser.parseKey();
    if (Object.hasOwn(dict, key)) throw new Error(`duplicate structured field key: ${key}`);

    if (parser.peek() === "=") {
      parser.consume("=");
      dict[key] = parser.parseItemOrInnerList();
    } else {
      dict[key] = { value: true, params: parser.parseParameters() };
    }

    parser.skipOwsp();
    if (parser.done()) break;
    parser.consume(",");
    parser.skipOwsp();
  }

  return dict;
}

export function serializeSf941Dict(dict: Sf941Dict): string {
  return Object.entries(dict)
    .map(([key, member]) => {
      assertSfKey(key);
      if (isInnerList(member)) return `${key}=${serializeInnerList(member)}`;
      if (member.value === true) return `${key}${serializeParameters(member.params)}`;
      return `${key}=${serializeBareItem(member.value)}${serializeParameters(member.params)}`;
    })
    .join(", ");
}

export function jcsCanonicalize(value: unknown): Uint8Array {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new Error("value cannot be JCS canonicalized");
  return Buffer.from(canonical, "utf8");
}

export async function signDetachedJws(args: {
  payload: Uint8Array;
  header: { alg: HmsAlgorithm; kid: string };
  privateKey: EcJwk;
}): Promise<string> {
  const protectedHeader = base64urlJson({ alg: args.header.alg, kid: args.header.kid });
  const payload = Buffer.from(args.payload).toString("base64url");
  const signingInput = Buffer.from(`${protectedHeader}.${payload}`, "ascii");
  const signature = await ecdsaSignRaw({
    algorithm: args.header.alg,
    privateKeyJwk: args.privateKey,
    data: signingInput
  });
  return `${protectedHeader}..${Buffer.from(signature).toString("base64url")}`;
}

export async function verifyDetachedJws(args: {
  jws: string;
  payload: Uint8Array;
  resolveKey: (kid: string, alg: HmsAlgorithm) => Promise<EcJwk | null>;
}): Promise<{ ok: true; kid: string; alg: HmsAlgorithm } | { ok: false; reason: string }> {
  const parts = args.jws.split(".");
  if (parts.length !== 3 || !parts[0] || parts[1] !== "" || !parts[2]) {
    return { ok: false, reason: "invalid_jws" };
  }

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "invalid_jws" };
  }

  if (!isHmsAlgorithm(header.alg) || typeof header.kid !== "string" || !header.kid) {
    return { ok: false, reason: "invalid_header" };
  }

  const key = await args.resolveKey(header.kid, header.alg);
  if (!key) return { ok: false, reason: "key_not_found" };

  const signingInput = Buffer.from(`${parts[0]}.${Buffer.from(args.payload).toString("base64url")}`, "ascii");
  const signature = Buffer.from(parts[2], "base64url");
  const ok = await ecdsaVerifyRaw({
    algorithm: header.alg,
    publicKeyJwk: key,
    data: signingInput,
    signature
  });
  return ok ? { ok: true, kid: header.kid, alg: header.alg } : { ok: false, reason: "signature_invalid" };
}

export async function ecdsaSignRaw(args: {
  algorithm: HmsAlgorithm;
  privateKeyJwk: EcJwk;
  data: Uint8Array;
}): Promise<Uint8Array> {
  const spec = assertAlgorithmKey(args.algorithm, args.privateKeyJwk, true);
  const key = createPrivateKey({ key: args.privateKeyJwk as NodeJsonWebKey, format: "jwk" });
  const signer = createSign(spec.hash);
  signer.update(args.data);
  return derToRaw(signer.sign(key), spec.width);
}

export async function ecdsaVerifyRaw(args: {
  algorithm: HmsAlgorithm;
  publicKeyJwk: EcJwk;
  data: Uint8Array;
  signature: Uint8Array;
}): Promise<boolean> {
  const spec = assertAlgorithmKey(args.algorithm, args.publicKeyJwk, false);
  if (args.signature.byteLength !== spec.width) return false;

  const key = createPublicKey({ key: args.publicKeyJwk as NodeJsonWebKey, format: "jwk" });
  const verifier = createVerify(spec.hash);
  verifier.update(args.data);
  return verifier.verify(key, rawToDer(args.signature));
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value.trim();
  }
  return out;
}

function componentValue(
  component: string,
  args: BuildSignatureBaseArgs,
  headers: Record<string, string>
): string {
  switch (component) {
    case "@method":
      if (!args.method) throw new Error("@method requires method");
      return args.method;
    case "@authority":
      if (!args.authority) throw new Error("@authority requires authority");
      return args.authority;
    case "@path":
      if (!args.path) throw new Error("@path requires path");
      return args.path;
    case "@query":
      if (args.query === undefined) throw new Error("@query requires query");
      return args.query.startsWith("?") ? args.query : `?${args.query}`;
    case "@status":
      if (args.status === undefined) throw new Error("@status requires status");
      return String(args.status);
    default: {
      if (component.startsWith("@")) throw new Error(`unsupported derived component: ${component}`);
      const value = headers[component.toLowerCase()];
      if (value === undefined) throw new Error(`missing covered header: ${component}`);
      return value;
    }
  }
}

function signatureParamsValue(components: string[], parameters: SignatureParameters): string {
  const list: Sf941InnerList = {
    kind: "inner-list",
    value: components.map((component) => {
      const identifier = parseComponentIdentifier(component);
      return { value: identifier.name, params: identifier.params };
    }),
    params: signatureParameters(parameters)
  };
  return serializeInnerList(list);
}

function signatureParameters(parameters: SignatureParameters): Record<string, Sf941BareItem> {
  if (!parameters.keyid) throw new Error("signature keyid is required");
  const out: Record<string, Sf941BareItem> = {};
  if (parameters.created !== undefined) out.created = assertSafeInteger(parameters.created, "created");
  if (parameters.expires !== undefined) out.expires = assertSafeInteger(parameters.expires, "expires");
  out.keyid = parameters.keyid;
  if (parameters.nonce !== undefined) out.nonce = parameters.nonce;
  return out;
}

function parseComponentIdentifier(component: string): { name: string; params?: Record<string, Sf941BareItem> } {
  const [name, ...paramParts] = component.split(";");
  if (!name) throw new Error("empty component identifier");
  if (paramParts.length === 0) return { name };
  const parser = new SfParser(`;${paramParts.join(";")}`);
  return { name, params: parser.parseParameters() };
}

function formatComponentIdentifier(identifier: { name: string; params?: Record<string, Sf941BareItem> }): string {
  return `${quoteString(identifier.name)}${serializeParameters(identifier.params)}`;
}

function isInnerList(member: Sf941DictMember): member is Sf941InnerList {
  return "kind" in member && member.kind === "inner-list";
}

function serializeInnerList(list: Sf941InnerList): string {
  const items = list.value.map((item) => `${serializeBareItem(item.value)}${serializeParameters(item.params)}`);
  return `(${items.join(" ")})${serializeParameters(list.params)}`;
}

function serializeParameters(params: Record<string, Sf941BareItem> | undefined): string {
  if (!params) return "";
  return Object.entries(params)
    .map(([key, value]) => {
      assertSfKey(key);
      return value === true ? `;${key}` : `;${key}=${serializeBareItem(value)}`;
    })
    .join("");
}

function serializeBareItem(value: Sf941BareItem): string {
  if (value instanceof Uint8Array) return `:${Buffer.from(value).toString("base64")}:`;
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "boolean") return value ? "?1" : "?0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("structured field number must be finite");
    return Number.isInteger(value) ? String(value) : trimDecimal(value.toFixed(3));
  }
  if (!SF_TOKEN.test(value.value)) throw new Error(`invalid structured field token: ${value.value}`);
  return value.value;
}

function quoteString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function trimDecimal(value: string): string {
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

function assertSfKey(key: string): void {
  if (!SF_KEY.test(key)) throw new Error(`invalid structured field key: ${key}`);
}

function assertSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function assertAlgorithmKey(algorithm: HmsAlgorithm, jwk: EcJwk, requirePrivate: boolean): AlgorithmSpec {
  const spec = ALGORITHMS[algorithm];
  if (jwk.kty !== "EC") throw new Error("ECDSA key must be an EC JWK");
  if (jwk.crv !== spec.curve) throw new Error(`${algorithm} requires ${spec.curve}`);
  if (jwk.alg !== undefined && jwk.alg !== algorithm) throw new Error(`JWK alg must be ${algorithm}`);
  if (requirePrivate && typeof jwk.d !== "string") throw new Error("private EC JWK must include d");
  return spec;
}

function isHmsAlgorithm(value: unknown): value is HmsAlgorithm {
  return value === "ES256" || value === "ES384";
}

function derToRaw(der: Uint8Array, width: 64 | 96): Uint8Array {
  const bytes = Buffer.from(der);
  let offset = 0;
  if (bytes[offset] !== 0x30) throw new Error("ECDSA signature is not a DER sequence");
  offset += 1;
  const sequenceLength = readDerLength(bytes, offset);
  offset = sequenceLength.offset;
  if (sequenceLength.length !== bytes.length - offset) throw new Error("invalid DER sequence length");
  const r = readDerInteger(bytes, offset);
  const s = readDerInteger(bytes, r.offset);
  if (s.offset !== bytes.length) throw new Error("unexpected trailing DER data");

  const half = width / 2;
  return Buffer.concat([leftPadUnsigned(r.value, half), leftPadUnsigned(s.value, half)]);
}

function rawToDer(raw: Uint8Array): Uint8Array {
  if (raw.byteLength % 2 !== 0) throw new Error("raw ECDSA signature length must be even");
  const half = raw.byteLength / 2;
  const r = derInteger(Buffer.from(raw.slice(0, half)));
  const s = derInteger(Buffer.from(raw.slice(half)));
  const payload = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30]), derLength(payload.byteLength), payload]);
}

function readDerInteger(bytes: Buffer, offset: number): { value: Uint8Array; offset: number } {
  if (bytes[offset] !== 0x02) throw new Error("expected DER integer");
  const length = readDerLength(bytes, offset + 1);
  const start = length.offset;
  const end = start + length.length;
  if (end > bytes.length) throw new Error("truncated DER integer");
  return { value: stripLeadingZeros(bytes.slice(start, end)), offset: end };
}

function readDerLength(bytes: Buffer, offset: number): { length: number; offset: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error("truncated DER length");
  if ((first & 0x80) === 0) return { length: first, offset: offset + 1 };
  const size = first & 0x7f;
  if (size === 0 || size > 4) throw new Error("unsupported DER length");
  let length = 0;
  for (let index = 0; index < size; index += 1) {
    const next = bytes[offset + 1 + index];
    if (next === undefined) throw new Error("truncated DER length");
    length = (length << 8) | next;
  }
  return { length, offset: offset + 1 + size };
}

function derInteger(value: Uint8Array): Uint8Array {
  let bytes = Buffer.from(stripLeadingZeros(value));
  if (bytes.byteLength === 0) bytes = Buffer.from([0]);
  if ((bytes[0]! & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02]), derLength(bytes.byteLength), bytes]);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function stripLeadingZeros(value: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < value.byteLength && value[offset] === 0) offset += 1;
  return value.slice(offset);
}

function leftPadUnsigned(value: Uint8Array, width: number): Uint8Array {
  const stripped = stripLeadingZeros(value);
  if (stripped.byteLength > width) throw new Error("DER integer is wider than target curve");
  return Buffer.concat([Buffer.alloc(width - stripped.byteLength), Buffer.from(stripped)]);
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

class SfParser {
  #index = 0;

  constructor(private readonly input: string) {}

  done(): boolean {
    return this.#index >= this.input.length;
  }

  peek(): string | undefined {
    return this.input[this.#index];
  }

  consume(char: string): void {
    if (this.input[this.#index] !== char) throw new Error(`expected "${char}" at ${this.#index}`);
    this.#index += 1;
  }

  skipOwsp(): void {
    while (this.input[this.#index] === " " || this.input[this.#index] === "\t") this.#index += 1;
  }

  parseKey(): string {
    const start = this.#index;
    while (!this.done() && /[a-z0-9_.*-]/.test(this.input[this.#index]!)) this.#index += 1;
    const key = this.input.slice(start, this.#index);
    assertSfKey(key);
    return key;
  }

  parseItemOrInnerList(): Sf941DictMember {
    if (this.peek() === "(") return this.parseInnerList();
    return this.parseItem();
  }

  parseInnerList(): Sf941InnerList {
    this.consume("(");
    const value: Sf941Item[] = [];
    while (true) {
      this.skipOwsp();
      if (this.peek() === ")") break;
      value.push(this.parseItem());
      if (this.peek() === ")") break;
      if (this.peek() !== " ") throw new Error(`expected inner-list space at ${this.#index}`);
      this.skipOwsp();
    }
    this.consume(")");
    return { kind: "inner-list", value, params: this.parseParameters() };
  }

  parseItem(): Sf941Item {
    const value = this.parseBareItem();
    const params = this.parseParameters();
    return Object.keys(params).length ? { value, params } : { value };
  }

  parseParameters(): Record<string, Sf941BareItem> {
    const params: Record<string, Sf941BareItem> = {};
    while (this.peek() === ";") {
      this.consume(";");
      const key = this.parseKey();
      if (this.peek() === "=") {
        this.consume("=");
        params[key] = this.parseBareItem();
      } else {
        params[key] = true;
      }
    }
    return params;
  }

  parseBareItem(): Sf941BareItem {
    const char = this.peek();
    if (char === "\"") return this.parseString();
    if (char === ":") return this.parseByteSequence();
    if (char === "?") return this.parseBoolean();
    if (char === "-" || isDigit(char)) return this.parseNumber();
    return this.parseToken();
  }

  parseString(): string {
    this.consume("\"");
    let out = "";
    while (!this.done()) {
      const char = this.input[this.#index]!;
      this.#index += 1;
      if (char === "\"") return out;
      if (char === "\\") {
        const escaped = this.input[this.#index];
        if (escaped !== "\"" && escaped !== "\\") throw new Error("invalid structured field string escape");
        out += escaped;
        this.#index += 1;
      } else {
        out += char;
      }
    }
    throw new Error("unterminated structured field string");
  }

  parseByteSequence(): Uint8Array {
    this.consume(":");
    const start = this.#index;
    while (!this.done() && this.peek() !== ":") this.#index += 1;
    if (this.done()) throw new Error("unterminated structured field byte sequence");
    const encoded = this.input.slice(start, this.#index);
    this.consume(":");
    return Buffer.from(encoded, "base64");
  }

  parseBoolean(): boolean {
    this.consume("?");
    const value = this.peek();
    if (value !== "0" && value !== "1") throw new Error("invalid structured field boolean");
    this.#index += 1;
    return value === "1";
  }

  parseNumber(): number {
    const start = this.#index;
    if (this.peek() === "-") this.#index += 1;
    while (isDigit(this.peek())) this.#index += 1;
    if (this.peek() === ".") {
      this.#index += 1;
      while (isDigit(this.peek())) this.#index += 1;
    }
    const raw = this.input.slice(start, this.#index);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`invalid structured field number: ${raw}`);
    return value;
  }

  parseToken(): Sf941Token {
    const start = this.#index;
    while (!this.done() && /[A-Za-z0-9!#$%&'*+\-.^_`|~:/]/.test(this.input[this.#index]!)) {
      this.#index += 1;
    }
    const value = this.input.slice(start, this.#index);
    if (!SF_TOKEN.test(value)) throw new Error(`invalid structured field token: ${value}`);
    return { kind: "token", value };
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}
