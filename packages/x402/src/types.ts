import type {
  AgentNativeInstrument,
  Decision,
  PaymentInstrumentRecord,
  PaymentMandate,
  PaymentMandateIssuer,
  PurchaseIntent
} from "@steelyard-dev/core";

export type X402Scheme = "exact" | "upto" | "batch-settlement" | (string & {});
export type X402Network = string;

export interface X402PaymentRequired {
  x402Version: number;
  accepts: X402PaymentRequirements[];
  error?: string;
}

export interface X402PaymentRequirements {
  scheme: X402Scheme;
  network: X402Network;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface X402ResourceContext {
  method: string;
  url: string;
  bodyHash: string;
  idempotencyKey: string;
  requirementHash: string;
}

export interface X402PaymentPayload {
  x402Version: number;
  scheme: X402Scheme;
  network: X402Network;
  payload: Record<string, unknown>;
  signature?: string;
  payer?: string;
  [key: string]: unknown;
}

export interface X402PaymentResponse {
  success: boolean;
  transaction?: string;
  network?: X402Network;
  payer?: string;
  error?: string;
  [key: string]: unknown;
}

export interface X402Receipt {
  idempotencyKey: string;
  requirementHash: string;
  requirements: X402PaymentRequirements;
  paymentResponse: X402PaymentResponse;
  resource: X402ResourceContext;
  settledAt: string;
  transaction?: string;
  network?: X402Network;
  payer?: string;
}

export interface X402FetchMetadata {
  requirements: X402PaymentRequirements;
  paymentPayload: X402PaymentPayload;
  receipt: X402Receipt;
}

export type X402FetchResponse = Response & { x402?: X402FetchMetadata };

export interface X402AmountLimit {
  amount: string;
  currency: string;
}

export interface X402FetchOptions {
  fetch?: typeof fetch;
  maxAmount?: X402AmountLimit;
  facilitator?: string;
  instrumentId?: string;
  allowedAssets?: readonly string[];
  allowedNetworks?: readonly string[];
  allowedSchemes?: readonly X402Scheme[];
  clock?: () => Date;
}

export interface X402Signer {
  readonly kind: "evm" | "solana" | (string & {});
  address(): Promise<string>;
  supportedNetworks(): Promise<readonly string[]>;
  signPayment(args: {
    requirements: X402PaymentRequirements;
    resource: X402ResourceContext;
    nonce: string;
    expiresAt?: string;
  }): Promise<X402PaymentPayload>;
}

export interface X402PaymentInstrumentOptions {
  signer: X402Signer;
  networks?: readonly X402Network[];
  assets?: readonly string[];
  schemes?: readonly X402Scheme[];
  allowMainnet?: boolean;
  label?: string;
  clock?: () => Date;
}

export type X402PaymentMandateIssuer = PaymentMandateIssuer;
export type X402PaymentInstrument = AgentNativeInstrument;

export interface X402WalletLike {
  decide(intent: PurchaseIntent): Promise<Decision>;
  chooseInstrument(intent: PurchaseIntent, opts?: {
    mode?: "agent-native" | "browser-manual";
    type?: string;
    instrumentId?: string;
  }): Promise<PaymentInstrumentRecord>;
  prepareMandate(intent: PurchaseIntent, opts?: {
    instrumentId?: string;
    handlerId?: string;
    transactionId?: string;
    idempotencyKey?: string;
    context?: Record<string, unknown>;
    ttlMs?: number;
    clock?: () => Date;
  }): Promise<PaymentMandate>;
}

export interface X402MandateContext {
  requirements: X402PaymentRequirements;
  resource: X402ResourceContext;
  facilitator?: string;
}

export interface X402VerifyResult {
  valid: boolean;
  reason?: string;
  payer?: string;
  network?: X402Network;
  [key: string]: unknown;
}

export interface X402SettleResult {
  success: boolean;
  transaction?: string;
  network?: X402Network;
  payer?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface X402FacilitatorClient {
  verify(args: {
    paymentPayload: X402PaymentPayload;
    paymentRequirements: X402PaymentRequirements;
  }): Promise<X402VerifyResult>;
  settle(args: {
    paymentPayload: X402PaymentPayload;
    paymentRequirements: X402PaymentRequirements;
  }): Promise<X402SettleResult>;
}

export interface X402FacilitatorClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface X402IdempotencyStore {
  get(key: string): Promise<X402SettleResult | undefined>;
  set(key: string, value: X402SettleResult): Promise<void>;
}

export type X402ProtectedHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) => Promise<Response | string | Uint8Array | Record<string, unknown> | undefined> |
  Response | string | Uint8Array | Record<string, unknown> | undefined;

export interface X402RouteRequirement extends X402PaymentRequirements {
  handler?: X402ProtectedHandler;
}

export interface X402PaywallOptions {
  facilitator: string | X402FacilitatorClient;
  routes: Record<string, X402RouteRequirement>;
  idempotencyStore?: X402IdempotencyStore;
  fetch?: typeof fetch;
  clock?: () => Date;
}
