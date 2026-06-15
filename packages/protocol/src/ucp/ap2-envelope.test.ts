// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  UcpAp2EnvelopeValidationError,
  assertValidAp2EnvelopeOnRequest,
  assertValidAp2EnvelopeOnResponse,
  isValidAp2EnvelopeOnRequest,
  isValidAp2EnvelopeOnResponse
} from "./index.js";

describe("AP2 envelope validators", () => {
  it("accepts SD-JWT+KB strings with a dotted KB-JWT segment", () => {
    const body = {
      ap2: {
        checkout_mandate: "issuer.header.sig~kb.header.sig"
      }
    };

    expect(assertValidAp2EnvelopeOnRequest(body)).toBe(body);
    expect(isValidAp2EnvelopeOnRequest(body)).toBe(true);
  });

  it("rejects missing or empty checkout mandates at the envelope layer", () => {
    expect(() => assertValidAp2EnvelopeOnRequest({})).toThrow(UcpAp2EnvelopeValidationError);
    expect(() => assertValidAp2EnvelopeOnRequest({ ap2: { checkout_mandate: "" } }))
      .toThrow(UcpAp2EnvelopeValidationError);
    expect(isValidAp2EnvelopeOnRequest({ ap2: { checkout_mandate: "" } })).toBe(false);
  });

  it("accepts non-empty merchant authorization strings without applying signature validation", () => {
    const body = {
      ap2: {
        merchant_authorization: "not-yet-verified"
      }
    };

    expect(assertValidAp2EnvelopeOnResponse(body)).toBe(body);
    expect(isValidAp2EnvelopeOnResponse(body)).toBe(true);
    expect(isValidAp2EnvelopeOnResponse({ ap2: { merchant_authorization: "" } })).toBe(false);
  });
});
