import { createHash } from "node:crypto";
import {
  X402NoSupportedRequirement,
  X402PaymentRequiredParseError,
  X402SettlementMissing
} from "./errors.js";
import type {
  X402PaymentPayload,
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentResponse,
  X402ResourceContext,
  X402Scheme
} from "./types.js";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

type HeaderSource = Headers | Record<string, string | string[] | undefined> | Iterable<[string, string]>;

export function isX402PaymentRequired(response: Response): boolean {
  return response.status === 402 && getHeader(response.headers, PAYMENT_REQUIRED_HEADER) !== undefined;
}

export function parsePaymentRequiredHeader(headers: HeaderSource): X402PaymentRequired {
  const value = getHeader(headers, PAYMENT_REQUIRED_HEADER);
  if (!value) throw new X402PaymentRequiredParseError("PAYMENT-REQUIRED header is missing");
  const parsed = decodeHeaderJson(value, "PAYMENT-REQUIRED");
  if (!isRecord(parsed) || typeof parsed.x402Version !== "number" || !Array.isArray(parsed.accepts)) {
    throw new X402PaymentRequiredParseError("PAYMENT-REQUIRED header does not contain a valid x402 challenge");
  }
  const accepts = parsed.accepts.map(parsePaymentRequirements);
  return {
    x402Version: parsed.x402Version,
    accepts,
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {})
  };
}

export function encodePaymentRequiredHeader(challenge: X402PaymentRequired): string {
  return encodeHeaderJson(challenge);
}

export function encodePaymentSignature(payload: X402PaymentPayload): string {
  return encodeHeaderJson(payload);
}

export function parsePaymentSignatureHeader(headers: HeaderSource): X402PaymentPayload {
  const value = getHeader(headers, PAYMENT_SIGNATURE_HEADER);
  if (!value) throw new X402PaymentRequiredParseError("PAYMENT-SIGNATURE header is missing");
  return parsePaymentPayload(decodeHeaderJson(value, "PAYMENT-SIGNATURE"));
}

export function encodePaymentResponseHeader(response: X402PaymentResponse): string {
  return encodeHeaderJson(response);
}

export function parsePaymentResponseHeader(headers: HeaderSource): X402PaymentResponse {
  const value = getHeader(headers, PAYMENT_RESPONSE_HEADER);
  if (!value) throw new X402SettlementMissing("PAYMENT-RESPONSE header is missing after paid retry");
  const parsed = decodeHeaderJson(value, "PAYMENT-RESPONSE");
  if (!isRecord(parsed) || typeof parsed.success !== "boolean") {
    throw new X402PaymentRequiredParseError("PAYMENT-RESPONSE header does not contain a valid settlement response");
  }
  return {
    success: parsed.success,
    ...(typeof parsed.transaction === "string" ? { transaction: parsed.transaction } : {}),
    ...(typeof parsed.network === "string" ? { network: parsed.network } : {}),
    ...(typeof parsed.payer === "string" ? { payer: parsed.payer } : {}),
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    ...parsed
  };
}

export function selectPaymentRequirement(
  requirements: readonly X402PaymentRequirements[],
  opts: {
    schemes?: readonly X402Scheme[];
    networks?: readonly string[];
    assets?: readonly string[];
  } = {}
): X402PaymentRequirements {
  const schemes = new Set((opts.schemes ?? ["exact"]).map(String));
  const networks = opts.networks ? new Set(opts.networks.map(String)) : undefined;
  const assets = opts.assets ? new Set(opts.assets.map((asset) => asset.toUpperCase())) : undefined;

  const candidates = requirements
    .map((requirement, index) => ({ requirement, index }))
    .filter(({ requirement }) => schemes.has(requirement.scheme))
    .filter(({ requirement }) => !networks || networks.has(requirement.network))
    .filter(({ requirement }) => !assets || assets.has(requirement.asset.toUpperCase()));

  if (!candidates.length) {
    throw new X402NoSupportedRequirement(
      `no supported x402 payment requirement for schemes=${[...schemes].join(",")} ` +
      `networks=${networks ? [...networks].join(",") : "*"} assets=${assets ? [...assets].join(",") : "*"}`
    );
  }

  return candidates.sort((left, right) => {
    const amount = compareDecimalStrings(left.requirement.maxAmountRequired, right.requirement.maxAmountRequired);
    if (amount !== 0) return amount;
    return left.index - right.index;
  })[0]!.requirement;
}

export function paymentRequirementHash(requirement: X402PaymentRequirements): string {
  return sha256Hex(stableJson(requirement));
}

export function resourceContext(args: {
  method: string;
  url: string;
  bodyHash: string;
  idempotencyKey: string;
  requirementHash: string;
}): X402ResourceContext {
  return {
    method: args.method.toUpperCase(),
    url: canonicalUrl(args.url),
    bodyHash: args.bodyHash,
    idempotencyKey: args.idempotencyKey,
    requirementHash: args.requirementHash
  };
}

export function deterministicIdempotencyKey(args: {
  method: string;
  url: string;
  bodyHash: string;
  requirementHash: string;
  instrumentId: string;
}): string {
  return `x402_${sha256Hex(stableJson({
    method: args.method.toUpperCase(),
    url: canonicalUrl(args.url),
    bodyHash: args.bodyHash,
    requirementHash: args.requirementHash,
    instrumentId: args.instrumentId
  })).slice(0, 40)}`;
}

export async function requestBodyHash(request: Request): Promise<string> {
  if (request.method === "GET" || request.method === "HEAD") return sha256Hex("");
  const bytes = new Uint8Array(await request.clone().arrayBuffer());
  return sha256Hex(bytes);
}

export function safeRequirementAmountToMinorUnits(requirement: X402PaymentRequirements): number {
  const decimals = decimalsForAsset(requirement.asset);
  const atomic = parseAtomicAmount(requirement.maxAmountRequired);
  if (atomic === undefined) return decimalToMinorUnits(requirement.maxAmountRequired, decimals);
  const divisor = 10n ** BigInt(decimals);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minor = decimals === 0 ? atomic : atomic;
  if (minor > maxSafe) return Number.MAX_SAFE_INTEGER;
  if (divisor === 1n) return Number(minor);
  return Number(minor);
}

export function assertAmountWithinLimit(requirement: X402PaymentRequirements, limit?: { amount: string; currency: string }): void {
  if (!limit) return;
  if (limit.currency.toUpperCase() !== requirement.asset.toUpperCase()) {
    throw new X402NoSupportedRequirement(
      `x402 requirement asset ${requirement.asset} does not match maxAmount currency ${limit.currency}`
    );
  }
  const decimals = decimalsForAsset(requirement.asset);
  const required = amountToComparable(requirement.maxAmountRequired, decimals);
  const allowed = decimalToBigInt(limit.amount, decimals);
  if (required > allowed) {
    throw new X402NoSupportedRequirement(
      `x402 requirement amount ${requirement.maxAmountRequired} ${requirement.asset} exceeds maxAmount ${limit.amount} ${limit.currency}`
    );
  }
}

export function toAtomicUnits(amount: string, asset: string): string {
  return decimalToBigInt(amount, decimalsForAsset(asset)).toString();
}

export function redactUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|key|password|signature|auth/i.test(key)) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }
  return url.toString();
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function getHeader(headers: HeaderSource, name: string): string | undefined {
  const target = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of headerEntries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function headerEntries(headers: HeaderSource): Array<[string, string]> {
  if (Symbol.iterator in Object(headers)) return [...headers as Iterable<[string, string]>];
  return Object.entries(headers as Record<string, string | string[] | undefined>)
    .flatMap(([key, value]) => {
      if (value === undefined) return [];
      return [[key, Array.isArray(value) ? value.join(", ") : value]] as Array<[string, string]>;
    });
}

function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeHeaderJson(value: string, headerName: string): unknown {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) {
    throw new X402PaymentRequiredParseError(`${headerName} header is not valid base64 JSON`);
  }
  try {
    const json = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch (error) {
    throw new X402PaymentRequiredParseError(`${headerName} header is not valid base64 JSON`, { cause: error });
  }
}

function parsePaymentRequirements(value: unknown): X402PaymentRequirements {
  if (!isRecord(value)) throw new X402PaymentRequiredParseError("x402 payment requirement must be an object");
  const required = ["scheme", "network", "asset", "payTo", "maxAmountRequired"] as const;
  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new X402PaymentRequiredParseError(`x402 payment requirement ${key} is required`);
    }
  }
  return {
    scheme: value.scheme as X402PaymentRequirements["scheme"],
    network: value.network as string,
    asset: value.asset as string,
    payTo: value.payTo as string,
    maxAmountRequired: value.maxAmountRequired as string,
    ...(typeof value.resource === "string" ? { resource: value.resource } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...("outputSchema" in value ? { outputSchema: value.outputSchema } : {}),
    ...(typeof value.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: value.maxTimeoutSeconds } : {}),
    ...(isRecord(value.extra) ? { extra: value.extra } : {})
  };
}

function parsePaymentPayload(value: unknown): X402PaymentPayload {
  if (!isRecord(value) || typeof value.x402Version !== "number" || typeof value.scheme !== "string" ||
    typeof value.network !== "string" || !isRecord(value.payload)) {
    throw new X402PaymentRequiredParseError("PAYMENT-SIGNATURE header does not contain a valid x402 payload");
  }
  return {
    x402Version: value.x402Version,
    scheme: value.scheme,
    network: value.network,
    payload: value.payload,
    ...(typeof value.signature === "string" ? { signature: value.signature } : {}),
    ...(typeof value.payer === "string" ? { payer: value.payer } : {}),
    ...value
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function compareDecimalStrings(left: string, right: string): number {
  const a = amountToComparable(left, 0);
  const b = amountToComparable(right, 0);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function amountToComparable(value: string, decimals: number): bigint {
  return parseAtomicAmount(value) ?? decimalToBigInt(value, decimals);
}

function parseAtomicAmount(value: string): bigint | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

function decimalToMinorUnits(value: string, decimals: number): number {
  const parsed = decimalToBigInt(value, decimals);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
}

function decimalToBigInt(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new X402PaymentRequiredParseError(`invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  if (fraction.length > decimals) throw new X402PaymentRequiredParseError(`amount has too many decimals for asset: ${value}`);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function decimalsForAsset(asset: string): number {
  if (asset.toUpperCase() === "USDC") return 6;
  return 0;
}
