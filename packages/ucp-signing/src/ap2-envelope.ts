// Copyright (c) Steelyard contributors. MIT License.
export interface Ap2WithCheckoutMandate {
  ap2: {
    checkout_mandate: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Ap2WithMerchantAuthorization {
  ap2: {
    merchant_authorization: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Ap2EnvelopeValidationErrorObject {
  instancePath: string;
  message: string;
}

export class UcpAp2EnvelopeValidationError extends Error {
  constructor(
    readonly envelope: "request" | "response",
    readonly errors: Ap2EnvelopeValidationErrorObject[] | null | undefined
  ) {
    super(`AP2 ${envelope} envelope failed validation: ${errorSummary(errors)}`);
    this.name = "UcpAp2EnvelopeValidationError";
  }
}

export function assertValidAp2EnvelopeOnRequest(value: unknown): Ap2WithCheckoutMandate {
  const errors = validateAp2Envelope(value, "checkout_mandate");
  if (errors) {
    throw new UcpAp2EnvelopeValidationError("request", errors);
  }
  return value as Ap2WithCheckoutMandate;
}

export function assertValidAp2EnvelopeOnResponse(value: unknown): Ap2WithMerchantAuthorization {
  const errors = validateAp2Envelope(value, "merchant_authorization");
  if (errors) {
    throw new UcpAp2EnvelopeValidationError("response", errors);
  }
  return value as Ap2WithMerchantAuthorization;
}

export function isValidAp2EnvelopeOnRequest(value: unknown): value is Ap2WithCheckoutMandate {
  return validateAp2Envelope(value, "checkout_mandate") === null;
}

export function isValidAp2EnvelopeOnResponse(value: unknown): value is Ap2WithMerchantAuthorization {
  return validateAp2Envelope(value, "merchant_authorization") === null;
}

function validateAp2Envelope(
  value: unknown,
  field: "checkout_mandate" | "merchant_authorization"
): Ap2EnvelopeValidationErrorObject[] | null {
  if (!isRecord(value)) {
    return [{ instancePath: "", message: "must be object" }];
  }
  if (!isRecord(value.ap2)) {
    return [{ instancePath: "/ap2", message: "must be object" }];
  }
  if (typeof value.ap2[field] !== "string" || !value.ap2[field]) {
    return [{ instancePath: `/ap2/${field}`, message: "must be non-empty string" }];
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorSummary(errors: Ap2EnvelopeValidationErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join(", ") ?? "unknown error";
}
