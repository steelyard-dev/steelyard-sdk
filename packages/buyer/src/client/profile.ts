// Copyright (c) Steelyard contributors. MIT License.
import type { RequestListener } from "node:http";
import { assertValidEcJwk, type EcJwk } from "@steelyard/core";
import {
  assertValidUcpProfile,
  UCP_AP2_CAPABILITY,
  UCP_CHECKOUT_CAPABILITY,
  UCP_VERSION,
  type UcpProfileDoc,
  type UcpPublicSigningKey
} from "@steelyard/protocol/ucp";

export interface UcpBuyerProfileOptions {
  signingKeys: readonly EcJwk[];
  ucpVersion?: string;
  ap2?: {
    enabled: true;
    spec?: string;
    schema?: string;
  };
}

export function createUcpBuyerProfile(args: UcpBuyerProfileOptions): UcpProfileDoc {
  if (args.signingKeys.length === 0) {
    throw new Error("signingKeys must contain at least one public UCP signing key");
  }
  const version = args.ucpVersion ?? UCP_VERSION;
  const doc: UcpProfileDoc = {
    ucp: {
      version,
      ...(args.ap2?.enabled
        ? {
            capabilities: {
              [UCP_AP2_CAPABILITY]: [
                {
                  version,
                  spec: args.ap2.spec ?? `https://ucp.dev/${version}/specification/ap2-mandates`,
                  schema: args.ap2.schema ?? `https://ucp.dev/${version}/schemas/shopping/ap2_mandate.json`,
                  extends: UCP_CHECKOUT_CAPABILITY,
                  config: {
                    vp_formats_supported: {
                      "dc+sd-jwt": {}
                    }
                  }
                }
              ]
            }
          }
        : {})
    },
    signing_keys: args.signingKeys.map(publicSigningKey)
  };
  assertValidUcpProfile(doc);
  return doc;
}

export function createUcpBuyerProfileHandler(args: UcpBuyerProfileOptions): RequestListener {
  const profile = createUcpBuyerProfile(args);
  const body = Buffer.from(JSON.stringify(profile), "utf8");

  return (req, res) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("Content-Length", String(body.byteLength));
    res.end(body);
  };
}

function publicSigningKey(value: EcJwk): UcpPublicSigningKey {
  const jwk = assertValidEcJwk(value);
  return {
    kid: jwk.kid,
    kty: "EC",
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    ...(jwk.use ? { use: jwk.use } : {}),
    ...(jwk.alg ? { alg: jwk.alg } : {})
  };
}
