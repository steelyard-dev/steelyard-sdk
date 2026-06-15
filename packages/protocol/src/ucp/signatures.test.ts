// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import { parseSf941Dict, type EcJwk } from "@steelyard/core";
import {
  UcpSignerMissingHeader,
  signUcpRequest,
  verifyUcpRequest,
  parseUcpAgentProfileUrl
} from "./index.js";

const now = new Date("2026-06-15T12:00:00.000Z");
const profileUrl = "https://wallet.example/.well-known/ucp";
const ucpAgent = `profile="${profileUrl}"`;

describe("signUcpRequest", () => {
  it("injects mandatory UCP headers and verifies with the signer profile key", async () => {
    const body = jsonBytes({ checkout: { line_items: [{ id: "double", quantity: 1 }] } });
    const signed = await signPost(body);

    expect(signed.headers["ucp-agent"]).toBe(ucpAgent);
    expect(signed.headers["content-digest"]).toBe("sha-256=:WJL8I/vwtimhpiVmqJtBb0Eebl32vLCxDYPU7TOooKA=:");
    expect(signed.headers["signature-input"]).toBe(
      "sig1=(\"@method\" \"@authority\" \"@path\" \"@query\" \"ucp-agent\" \"idempotency-key\" \"content-digest\" \"content-type\");keyid=\"wallet-p256\""
    );
    expect(signed.headers["signature-input"]).not.toContain("sig1=sig1=");
    expect(parseSf941Dict(signed.headers.signature!).sig1).toHaveProperty("value");

    const result = await verifyUcpRequest({
      method: "POST",
      url: new URL("https://merchant.example:443/ucp/api/checkout?mode=test"),
      headers: signed.headers,
      body,
      resolveKey: async (kid, signerProfileUrl) =>
        kid === "wallet-p256" && signerProfileUrl === profileUrl ? walletP256PublicKey : null,
      now
    });

    expect(result).toEqual({
      ok: true,
      kid: "wallet-p256",
      algorithm: "ES256",
      signerProfileUrl: profileUrl
    });
  });

  it("fails before signing if mutating requests or bodies lack required headers", async () => {
    const body = jsonBytes({ checkout: {} });
    await expect(
      signUcpRequest({
        method: "POST",
        url: new URL("https://merchant.example/ucp/api/checkout"),
        headers: { "content-type": "application/json" },
        body,
        signing: { kid: "wallet-p256", algorithm: "ES256", privateKey: walletP256PrivateKey },
        ucpAgent,
        now
      })
    ).rejects.toMatchObject(new UcpSignerMissingHeader("idempotency-key"));

    await expect(
      signUcpRequest({
        method: "POST",
        url: new URL("https://merchant.example/ucp/api/checkout"),
        headers: { "idempotency-key": "create-1" },
        body,
        signing: { kid: "wallet-p256", algorithm: "ES256", privateKey: walletP256PrivateKey },
        ucpAgent,
        now
      })
    ).rejects.toMatchObject(new UcpSignerMissingHeader("content-type"));
  });

  it("signs read requests without idempotency or body digest components", async () => {
    const signed = await signUcpRequest({
      method: "GET",
      url: new URL("https://merchant.example/ucp/api/checkout/checkout_1"),
      headers: {},
      signing: { kid: "wallet-p256", algorithm: "ES256", privateKey: walletP256PrivateKey },
      ucpAgent,
      now
    });

    expect(signed.headers["signature-input"]).toBe(
      "sig1=(\"@method\" \"@authority\" \"@path\" \"ucp-agent\");keyid=\"wallet-p256\""
    );
    await expect(
      verifyUcpRequest({
        method: "GET",
        url: new URL("https://merchant.example/ucp/api/checkout/checkout_1"),
        headers: signed.headers,
        resolveKey: async () => walletP256PublicKey,
        now
      })
    ).resolves.toMatchObject({ ok: true, kid: "wallet-p256" });
  });
});

describe("verifyUcpRequest", () => {
  it("rejects missing and malformed signature headers", async () => {
    await expect(
      verifyUcpRequest({
        method: "GET",
        url: new URL("https://merchant.example/ucp/api/checkout/checkout_1"),
        headers: {},
        resolveKey: async () => walletP256PublicKey,
        now
      })
    ).resolves.toEqual({ ok: false, reason: "signature_missing" });

    const signed = await signPost(jsonBytes({ checkout: {} }));
    await expect(verifySigned({ ...signed.headers, signature: "sig1=notbytes" }, jsonBytes({ checkout: {} })))
      .resolves.toEqual({ ok: false, reason: "signature_invalid", detail: "signature_invalid_format" });
    await expect(verifySigned({ ...signed.headers, signature: "sig1=:" }, jsonBytes({ checkout: {} })))
      .resolves.toEqual({ ok: false, reason: "signature_invalid", detail: "signature_invalid_format" });
  });

  it("rejects tampered bodies with digest_mismatch before signature verification", async () => {
    const signed = await signPost(jsonBytes({ checkout: { line_items: [{ id: "double", quantity: 1 }] } }));

    await expect(verifySigned(signed.headers, jsonBytes({ checkout: { line_items: [{ id: "double", quantity: 2 }] } })))
      .resolves.toEqual({ ok: false, reason: "digest_mismatch" });
    await expect(verifySigned({ ...signed.headers, "content-digest": "sha-256=:" }, jsonBytes({ checkout: {} })))
      .resolves.toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("rejects missing mandatory headers before checking coverage", async () => {
    const body = jsonBytes({ checkout: {} });
    const signed = await signPost(body);

    for (const header of ["ucp-agent", "idempotency-key", "content-type", "content-digest"]) {
      const headers = { ...signed.headers };
      delete headers[header];
      await expect(verifySigned(headers, body)).resolves.toEqual({
        ok: false,
        reason: "signature_invalid",
        detail: `mandatory_header_missing: ${header}`
      });
    }
  });

  it("rejects required components omitted from Signature-Input coverage", async () => {
    const body = jsonBytes({ checkout: {} });
    const signed = await signPost(body);
    const signatureInput = signed.headers["signature-input"]!;
    const headers = {
      ...signed.headers,
      "signature-input": signatureInput.replace(" \"content-digest\"", "")
    };

    await expect(verifySigned(headers, body)).resolves.toEqual({
      ok: false,
      reason: "signature_invalid",
      detail: "required_component_not_covered: content-digest"
    });
  });

  it("rejects alg parameters, unknown kids, unsupported algorithms, and bad signatures", async () => {
    const body = jsonBytes({ checkout: {} });
    const signed = await signPost(body);
    const signatureInput = signed.headers["signature-input"]!;

    await expect(
      verifySigned({
        ...signed.headers,
        "signature-input": signatureInput.replace(";keyid=", ";alg=\"ES256\";keyid=")
      }, body)
    ).resolves.toEqual({ ok: false, reason: "signature_invalid", detail: "signature_input_invalid" });

    await expect(verifySigned(signed.headers, body, async () => null)).resolves.toEqual({
      ok: false,
      reason: "key_not_found"
    });

    await expect(verifySigned(signed.headers, body, async () => ({ ...walletP256PublicKey, crv: "P-521" }) as unknown as EcJwk))
      .resolves.toMatchObject({ ok: false, reason: "algorithm_unsupported" });

    await expect(
      verifyUcpRequest({
        method: "POST",
        url: new URL("https://merchant.example/ucp/api/checkout-wrong"),
        headers: signed.headers,
        body,
        resolveKey: async () => walletP256PublicKey,
        now
      })
    ).resolves.toMatchObject({ ok: false, reason: "signature_invalid" });
  });

  it("parses UCP-Agent profile URLs as RFC 8941 dictionaries", () => {
    expect(parseUcpAgentProfileUrl("profile=\"https://platform.example/.well-known/ucp\"")).toBe(
      "https://platform.example/.well-known/ucp"
    );
    expect(parseUcpAgentProfileUrl("mode=live")).toBeNull();
    expect(parseUcpAgentProfileUrl("profile")).toBeNull();
    expect(parseUcpAgentProfileUrl("profile=(\"https://platform.example/.well-known/ucp\")")).toBeNull();
    expect(parseUcpAgentProfileUrl("profile=\"not a url\"")).toBeNull();
  });

  it("rejects malformed UCP-Agent profiles before key resolution", async () => {
    const body = jsonBytes({ checkout: {} });
    const signed = await signPost(body);

    await expect(verifySigned({ ...signed.headers, "ucp-agent": "profile=\"not a url\"" }, body))
      .resolves.toEqual({ ok: false, reason: "signature_invalid", detail: "ucp_agent_invalid" });
  });
});

async function signPost(body: Uint8Array): Promise<{ headers: Record<string, string> }> {
  return await signUcpRequest({
    method: "POST",
    url: new URL("https://merchant.example:443/ucp/api/checkout?mode=test"),
    headers: {
      "content-type": "application/json",
      "idempotency-key": "create-1"
    },
    body,
    signing: { kid: "wallet-p256", algorithm: "ES256", privateKey: walletP256PrivateKey },
    ucpAgent,
    now
  });
}

async function verifySigned(
  headers: Record<string, string>,
  body: Uint8Array,
  resolveKey: (kid: string, signerProfileUrl: string) => Promise<EcJwk | null> = async (kid, signerProfileUrl) =>
    kid === "wallet-p256" && signerProfileUrl === profileUrl ? walletP256PublicKey : null
) {
  return await verifyUcpRequest({
    method: "POST",
    url: new URL("https://merchant.example/ucp/api/checkout?mode=test"),
    headers,
    body,
    resolveKey,
    now
  });
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
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
