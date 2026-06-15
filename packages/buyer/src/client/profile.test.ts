// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { EcJwk } from "@steelyard/core";
import { assertValidUcpProfile, UcpProfileCache } from "@steelyard/protocol/ucp";
import { createUcpBuyerProfile, createUcpBuyerProfileHandler } from "./index.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("createUcpBuyerProfile", () => {
  it("builds a schema-valid public signer profile", () => {
    const profile = createUcpBuyerProfile({ signingKeys: [walletP256PublicKey] });

    expect(() => assertValidUcpProfile(profile)).not.toThrow();
    expect(profile).toEqual({
      ucp: { version: "2026-04-17" },
      signing_keys: [walletP256PublicKey]
    });
  });

  it("rejects private key material and never serializes d", () => {
    expect(() => createUcpBuyerProfile({ signingKeys: [walletP256PrivateKey] })).toThrow(/private d is not allowed/);

    expect(JSON.stringify(createUcpBuyerProfile({ signingKeys: [walletP256PublicKey] }))).not.toContain('"d":');
  });

  it("requires at least one signing key", () => {
    expect(() => createUcpBuyerProfile({ signingKeys: [] })).toThrow(/at least one/);
  });
});

describe("createUcpBuyerProfileHandler", () => {
  it("serves the profile on GET and rejects other verbs", async () => {
    const baseUrl = await startBuyerProfileServer();

    const get = await fetch(baseUrl);
    await expect(get.json()).resolves.toMatchObject({
      ucp: { version: "2026-04-17" },
      signing_keys: [expect.objectContaining({ kid: "wallet-p256" })]
    });

    const post = await fetch(baseUrl, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("round-trips through the UCP profile cache for exact kid resolution", async () => {
    const baseUrl = await startBuyerProfileServer();
    const cache = new UcpProfileCache();

    await expect(cache.resolveSigningKey(baseUrl, "wallet-p256", {
      allowPrivateNetwork: true
    })).resolves.toMatchObject({ kid: "wallet-p256" });
    await expect(cache.resolveSigningKey(baseUrl, "wallet-p256 ", {
      allowPrivateNetwork: true
    })).resolves.toBeNull();
  });
});

async function startBuyerProfileServer(): Promise<string> {
  server = createServer(createUcpBuyerProfileHandler({ signingKeys: [walletP256PublicKey] }));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}/buyer/.well-known/ucp`;
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const walletP256PublicKey = {
  kid: "wallet-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const walletP256PrivateKey = {
  ...walletP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;
