// Copyright (c) Steelyard contributors. MIT License.
import { jcsCanonicalize, verifyDetachedJws, type EcJwk } from "@steelyard-dev/core";
import type { Checkout } from "@steelyard-dev/protocol/ucp/checkout";
import { describe, expect, it } from "vitest";
import {
  Ap2MerchantAuthorizationSignerConfigError,
  ap2MerchantAuthorizationSigner,
  checkoutWithoutAp2
} from "./index.js";

describe("ap2MerchantAuthorizationSigner", () => {
  it("signs a detached JWS over checkout bytes with the ap2 field omitted (MA5-1)", async () => {
    const signer = ap2MerchantAuthorizationSigner({
      signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" }],
      activeKid: "merchant-p256"
    });
    const checkout = sampleCheckout({
      ap2: {
        merchant_authorization: "stale",
        checkout_mandate: "future"
      }
    });

    const jws = await signer.sign(checkout);
    const parts = jws.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe("");
    expect(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: "merchant-p256"
    });
    await expect(
      verifyDetachedJws({
        jws,
        payload: jcsCanonicalize(checkoutWithoutAp2(checkout)),
        resolveKey: async (kid, alg) => (kid === "merchant-p256" && alg === "ES256" ? merchantP256PublicKey : null)
      })
    ).resolves.toEqual({ ok: true, kid: "merchant-p256", alg: "ES256" });
    await expect(
      verifyDetachedJws({
        jws,
        payload: jcsCanonicalize(checkout),
        resolveKey: async () => merchantP256PublicKey
      })
    ).resolves.toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("uses the configured active key and validates it at construction", async () => {
    const signer = ap2MerchantAuthorizationSigner({
      signingKeys: [
        { kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" },
        { kid: "merchant-p384", privateKeyJwk: merchantP384PrivateKey, algorithm: "ES384" }
      ],
      activeKid: "merchant-p384"
    });

    const jws = await signer.sign(sampleCheckout());
    await expect(
      verifyDetachedJws({
        jws,
        payload: jcsCanonicalize(sampleCheckout()),
        resolveKey: async (kid, alg) => (kid === "merchant-p384" && alg === "ES384" ? merchantP384PublicKey : null)
      })
    ).resolves.toEqual({ ok: true, kid: "merchant-p384", alg: "ES384" });

    expect(() => ap2MerchantAuthorizationSigner({ signingKeys: [], activeKid: "merchant-p256" })).toThrow(
      Ap2MerchantAuthorizationSignerConfigError
    );
    expect(() =>
      ap2MerchantAuthorizationSigner({
        signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES256" }],
        activeKid: "missing"
      })
    ).toThrow(/activeKid/);
    expect(() =>
      ap2MerchantAuthorizationSigner({
        signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PublicKey, algorithm: "ES256" }],
        activeKid: "merchant-p256"
      })
    ).toThrow(/private d/);
    expect(() =>
      ap2MerchantAuthorizationSigner({
        signingKeys: [{ kid: "merchant-p256", privateKeyJwk: merchantP256PrivateKey, algorithm: "ES384" }],
        activeKid: "merchant-p256"
      })
    ).toThrow(/ES256/);
  });
});

function sampleCheckout(overrides: Partial<Checkout> = {}): Checkout {
  return {
    ucp: { version: "2026-04-17", status: "success", payment_handlers: {} },
    id: "checkout_123",
    status: "ready_for_complete",
    line_items: [{ id: "latte", title: "Latte", quantity: 1, amount: 500 }],
    totals: { subtotal: 500, total: 500 },
    currency: "usd",
    ...overrides
  };
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const merchantP256PublicKey = {
  kid: "merchant-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const merchantP256PrivateKey = {
  ...merchantP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

const merchantP384PublicKey = {
  kid: "merchant-p384",
  kty: "EC",
  crv: "P-384",
  x: b64urlHex(
    "EC3A4E415B4E19A4568618029F427FA5DA9A8BC4AE92E02E06AAE5286B300C64" +
      "DEF8F0EA9055866064A254515480BC13"
  ),
  y: b64urlHex(
    "8015D9B72D7D57244EA8EF9AC0C621896708A59367F9DFB9F54CA84B3F1C9DB1" +
      "288B231C3AE0D4FE7344FD2533264720"
  ),
  use: "sig",
  alg: "ES384"
} satisfies EcJwk;

const merchantP384PrivateKey = {
  ...merchantP384PublicKey,
  d: b64urlHex("6B9D3DAD2E1B8C1C05B19875B6659F4DE23C3B667BF297BA9AA47740787137D8" + "96D5724E4C70A825F872C9EA60D2EDF5")
} satisfies EcJwk;
