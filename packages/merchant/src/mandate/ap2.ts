// Copyright (c) Steelyard contributors. MIT License.
import {
  assertValidEcJwk,
  ecdsaSignRaw,
  type EcJwk,
  type HmsAlgorithm
} from "@steelyard-dev/core";
import {
  Ap2MerchantAuthorizationSignerConfigError,
  ap2MerchantAuthorizationSigner as ap2MerchantAuthorizationSignerForUcpSigner,
  checkoutWithoutAp2
} from "@steelyard-dev/ucp-signing";
import type { UcpSigner } from "@steelyard-dev/ucp-signing";
import type { Checkout } from "@steelyard-dev/protocol/ucp/checkout";
import type { HmsSigningKey } from "../checkout/index.js";

export interface MerchantAuthorizationSigner {
  sign(checkout: Checkout): Promise<string>;
}

export interface Ap2MerchantAuthorizationSignerOptions {
  signingKeys: HmsSigningKey[];
  activeKid: string;
}

export { Ap2MerchantAuthorizationSignerConfigError, checkoutWithoutAp2 };

export function ap2MerchantAuthorizationSigner(
  opts: Ap2MerchantAuthorizationSignerOptions
): MerchantAuthorizationSigner {
  const signingKey = activeSigningKey(opts);
  const privateKey = validPrivateSigningKey(signingKey);
  return ap2MerchantAuthorizationSignerForUcpSigner({
    signer: signerFromPrivateKey(signingKey, privateKey)
  }) as MerchantAuthorizationSigner;
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

function signerFromPrivateKey(signingKey: HmsSigningKey, privateKey: EcJwk): UcpSigner {
  return {
    async publicJwk() {
      const { d: _private, ...publicKey } = privateKey as EcJwk & { d?: string };
      return JSON.parse(JSON.stringify(publicKey)) as EcJwk;
    },
    async sign(data, alg) {
      if (alg !== signingKey.algorithm) {
        throw new Error(`AP2 merchant authorization signer ${signingKey.kid} uses ${signingKey.algorithm}, not ${alg}`);
      }
      return await ecdsaSignRaw({
        algorithm: alg,
        privateKeyJwk: privateKey,
        data
      });
    }
  };
}

function algorithmForCurve(curve: EcJwk["crv"]): HmsAlgorithm {
  return curve === "P-256" ? "ES256" : "ES384";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
