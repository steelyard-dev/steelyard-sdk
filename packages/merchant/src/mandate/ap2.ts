// Copyright (c) Steelyard contributors. MIT License.
import {
  assertValidEcJwk,
  jcsCanonicalize,
  signDetachedJws,
  type EcJwk,
  type HmsAlgorithm
} from "@steelyard/core";
import type { Checkout } from "@steelyard/protocol/ucp/checkout";
import type { HmsSigningKey } from "../checkout/index.js";

export interface MerchantAuthorizationSigner {
  sign(checkout: Checkout): Promise<string>;
}

export interface Ap2MerchantAuthorizationSignerOptions {
  signingKeys: HmsSigningKey[];
  activeKid: string;
}

export class Ap2MerchantAuthorizationSignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ap2MerchantAuthorizationSignerConfigError";
  }
}

export function ap2MerchantAuthorizationSigner(
  opts: Ap2MerchantAuthorizationSignerOptions
): MerchantAuthorizationSigner {
  const signingKey = activeSigningKey(opts);
  const privateKey = validPrivateSigningKey(signingKey);
  const { algorithm, kid } = signingKey;

  return {
    async sign(checkout) {
      return await signDetachedJws({
        payload: jcsCanonicalize(checkoutWithoutAp2(checkout)),
        header: { alg: algorithm, kid },
        privateKey
      });
    }
  };
}

export function checkoutWithoutAp2(checkout: Checkout): Checkout {
  const { ap2: _ap2, ...payload } = checkout;
  return payload;
}

function activeSigningKey(opts: Ap2MerchantAuthorizationSignerOptions): HmsSigningKey {
  if (!Array.isArray(opts.signingKeys) || opts.signingKeys.length === 0) {
    throw new Ap2MerchantAuthorizationSignerConfigError("AP2 merchant authorization signingKeys is required");
  }
  if (!opts.activeKid) {
    throw new Ap2MerchantAuthorizationSignerConfigError("AP2 merchant authorization activeKid is required");
  }
  const active = opts.signingKeys.find((key) => key.kid === opts.activeKid);
  if (!active) {
    throw new Ap2MerchantAuthorizationSignerConfigError(
      "AP2 merchant authorization activeKid must match a configured signing key"
    );
  }
  return active;
}

function validPrivateSigningKey(signingKey: HmsSigningKey): EcJwk {
  let jwk: EcJwk;
  try {
    jwk = assertValidEcJwk(signingKey.privateKeyJwk, { allowPrivate: true });
  } catch (cause) {
    throw new Ap2MerchantAuthorizationSignerConfigError(
      `AP2 merchant authorization signing key ${signingKey.kid} is invalid: ${errorMessage(cause)}`
    );
  }
  if (!jwk.d) {
    throw new Ap2MerchantAuthorizationSignerConfigError(
      `AP2 merchant authorization signing key ${signingKey.kid} must include private d`
    );
  }
  if (jwk.kid !== signingKey.kid) {
    throw new Ap2MerchantAuthorizationSignerConfigError(
      `AP2 merchant authorization signing key ${signingKey.kid} must match privateKeyJwk.kid`
    );
  }
  const expectedAlgorithm = algorithmForCurve(jwk.crv);
  if (signingKey.algorithm !== expectedAlgorithm) {
    throw new Ap2MerchantAuthorizationSignerConfigError(
      `AP2 merchant authorization signing key ${signingKey.kid} algorithm must be ${expectedAlgorithm}`
    );
  }
  return jwk;
}

function algorithmForCurve(curve: EcJwk["crv"]): HmsAlgorithm {
  return curve === "P-256" ? "ES256" : "ES384";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
