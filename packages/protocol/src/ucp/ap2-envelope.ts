// Copyright (c) Steelyard contributors. MIT License.
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

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

export class UcpAp2EnvelopeValidationError extends Error {
  constructor(
    readonly envelope: "request" | "response",
    readonly errors: ErrorObject[] | null | undefined
  ) {
    super(`AP2 ${envelope} envelope failed validation: ${ajv.errorsText(errors)}`);
    this.name = "UcpAp2EnvelopeValidationError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

const nonEmptyString = { type: "string", minLength: 1 };

const validateRequest = ajv.compile({
  type: "object",
  required: ["ap2"],
  properties: {
    ap2: {
      type: "object",
      required: ["checkout_mandate"],
      properties: {
        checkout_mandate: nonEmptyString
      },
      additionalProperties: true
    }
  },
  additionalProperties: true
}) as ValidateFunction<Ap2WithCheckoutMandate>;

const validateResponse = ajv.compile({
  type: "object",
  required: ["ap2"],
  properties: {
    ap2: {
      type: "object",
      required: ["merchant_authorization"],
      properties: {
        merchant_authorization: nonEmptyString
      },
      additionalProperties: true
    }
  },
  additionalProperties: true
}) as ValidateFunction<Ap2WithMerchantAuthorization>;

export function assertValidAp2EnvelopeOnRequest(value: unknown): Ap2WithCheckoutMandate {
  if (!validateRequest(value)) {
    throw new UcpAp2EnvelopeValidationError("request", validateRequest.errors);
  }
  return value as Ap2WithCheckoutMandate;
}

export function assertValidAp2EnvelopeOnResponse(value: unknown): Ap2WithMerchantAuthorization {
  if (!validateResponse(value)) {
    throw new UcpAp2EnvelopeValidationError("response", validateResponse.errors);
  }
  return value as Ap2WithMerchantAuthorization;
}

export function isValidAp2EnvelopeOnRequest(value: unknown): value is Ap2WithCheckoutMandate {
  return validateRequest(value);
}

export function isValidAp2EnvelopeOnResponse(value: unknown): value is Ap2WithMerchantAuthorization {
  return validateResponse(value);
}
