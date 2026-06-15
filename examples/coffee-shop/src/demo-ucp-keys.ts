import type { EcJwk } from "@steelyard/core";

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

// Demo-only plaintext UCP HMS key material for the local coffee-shop example.
// Production merchants and buyer platforms must keep private key material in
// process-local secrets, a vault, or an HSM-backed signer and publish only the
// public JWK fields in UCP profiles.
export const merchantDemoUcpPublicKey = {
  kid: "coffee-merchant-p256-demo",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

export const merchantDemoUcpPrivateKey = {
  ...merchantDemoUcpPublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

export const buyerDemoUcpPublicKey = {
  ...merchantDemoUcpPublicKey,
  kid: "coffee-buyer-p256-demo"
} satisfies EcJwk;

export const buyerDemoUcpPrivateKey = {
  ...buyerDemoUcpPublicKey,
  d: merchantDemoUcpPrivateKey.d
} satisfies EcJwk;

export const coffeeShopBearerToken = "coffee-shop-bearer-demo";
