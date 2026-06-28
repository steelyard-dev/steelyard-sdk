// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  assertValidEcJwk,
  buildSignatureBase,
  contentDigestHeader,
  ecdsaSignRaw,
  ecdsaVerifyRaw,
  jcsCanonicalize,
  normalizeAuthority,
  parseSf941Dict,
  serializeSf941Dict,
  signDetachedJws,
  verifyDetachedJws,
  type EcJwk,
  type Sf941InnerList,
  type Sf941Token,
  type UcpErrorEnvelope,
  type V04ErrorEnvelope
} from "./index.js";

describe("RFC 9421 signature bases", () => {
  it("matches the RFC 9421 B.2.5 request signature base", () => {
    const base = buildSignatureBase({
      method: "POST",
      authority: "example.com",
      path: "/foo",
      headers: {
        date: "Tue, 20 Apr 2021 02:07:55 GMT",
        "content-type": "application/json"
      },
      components: ["date", "@authority", "content-type"],
      parameters: { created: 1618884473, keyid: "test-shared-secret" }
    });

    expect(text(base)).toBe(
      [
        "\"date\": Tue, 20 Apr 2021 02:07:55 GMT",
        "\"@authority\": example.com",
        "\"content-type\": application/json",
        "\"@signature-params\": (\"date\" \"@authority\" \"content-type\");created=1618884473;keyid=\"test-shared-secret\""
      ].join("\n")
    );
  });

  it("matches the RFC 9421 B.2.4 response signature base", () => {
    const base = buildSignatureBase({
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-digest":
          "sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:",
        "content-length": "23"
      },
      components: ["@status", "content-type", "content-digest", "content-length"],
      parameters: { created: 1618884473, keyid: "test-key-ecc-p256" }
    });

    expect(text(base)).toBe(
      [
        "\"@status\": 200",
        "\"content-type\": application/json",
        "\"content-digest\": sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:",
        "\"content-length\": 23",
        "\"@signature-params\": (\"@status\" \"content-type\" \"content-digest\" \"content-length\");created=1618884473;keyid=\"test-key-ecc-p256\""
      ].join("\n")
    );
  });

  it("builds UCP-style request bases with query values and component parameters", () => {
    const base = buildSignatureBase({
      method: "POST",
      authority: "merchant.example",
      path: "/checkout-sessions",
      query: "mode=test",
      headers: {
        "ucp-agent": "profile=\"https://platform.example/.well-known/ucp\""
      },
      components: ["@method", "@authority", "@path", "@query;name=\"mode\"", "ucp-agent"],
      parameters: { keyid: "platform-2026" }
    });

    expect(text(base)).toBe(
      [
        "\"@method\": POST",
        "\"@authority\": merchant.example",
        "\"@path\": /checkout-sessions",
        "\"@query\";name=\"mode\": ?mode=test",
        "\"ucp-agent\": profile=\"https://platform.example/.well-known/ucp\"",
        "\"@signature-params\": (\"@method\" \"@authority\" \"@path\" \"@query\";name=\"mode\" \"ucp-agent\");keyid=\"platform-2026\""
      ].join("\n")
    );
  });

  it("rejects missing required derived components", () => {
    expect(() =>
      buildSignatureBase({
        headers: {},
        components: ["@method"],
        parameters: { keyid: "kid" }
      })
    ).toThrow(/@method/);
    expect(() =>
      buildSignatureBase({
        method: "GET",
        headers: {},
        components: ["@authority"],
        parameters: { keyid: "kid" }
      })
    ).toThrow(/@authority/);
    expect(() =>
      buildSignatureBase({
        method: "GET",
        authority: "example.com",
        headers: {},
        components: ["@path"],
        parameters: { keyid: "kid" }
      })
    ).toThrow(/@path/);
    expect(() =>
      buildSignatureBase({
        method: "GET",
        authority: "example.com",
        path: "/",
        headers: {},
        components: ["@query"],
        parameters: { keyid: "kid" }
      })
    ).toThrow(/@query/);
  });

  it("normalizes @authority per RFC 9421 without userinfo or default ports", () => {
    expect(normalizeAuthority(new URL("https://USER:pw@Example.COM:443/path"))).toBe("example.com");
    expect(normalizeAuthority(new URL("http://Example.COM:80/path"))).toBe("example.com");
    expect(normalizeAuthority(new URL("https://Example.COM:8443/path"))).toBe("example.com:8443");
  });
});

describe("RFC 9530 content digests", () => {
  it("matches RFC 9530 Appendix D sample digest values", () => {
    const body = Buffer.from("{\"hello\": \"world\"}", "utf8");

    expect(contentDigestHeader({ body })).toBe("sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:");
    expect(contentDigestHeader({ body, algorithm: "sha-512" })).toBe(
      "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:"
    );
  });
});

describe("RFC 8941 dictionary parser", () => {
  it("round-trips dictionary examples and Signature-Input without double-prefixing", () => {
    expect(serializeSf941Dict(parseSf941Dict("en=\"Applepie\", da=:w4ZibGV0w6ZydGU=:"))).toBe(
      "en=\"Applepie\", da=:w4ZibGV0w6ZydGU=:"
    );
    expect(serializeSf941Dict(parseSf941Dict("rating=1.5, feelings=(joy sadness)"))).toBe(
      "rating=1.5, feelings=(joy sadness)"
    );
    expect(serializeSf941Dict(parseSf941Dict("a=?0, b, c;foo=bar, flag;secure"))).toBe(
      "a=?0, b, c;foo=bar, flag;secure"
    );
    expect(serializeSf941Dict(parseSf941Dict("escaped=\"a\\\\\\\"b\""))).toBe("escaped=\"a\\\\\\\"b\"");

    const signatureInput = serializeSf941Dict({
      sig1: {
        kind: "inner-list",
        value: [{ value: "@method" }, { value: "@authority" }, { value: "ucp-agent" }],
        params: { keyid: "platform-2026" }
      }
    });
    expect(signatureInput).toBe("sig1=(\"@method\" \"@authority\" \"ucp-agent\");keyid=\"platform-2026\"");
    expect(signatureInput).not.toContain("sig1=sig1=");
  });

  it("exposes item values and parameters for UCP-Agent parsing", () => {
    const parsed = parseSf941Dict("profile=\"https://platform.example/.well-known/ucp\", mode=live");
    expect(parsed.profile).toEqual({ value: "https://platform.example/.well-known/ucp" });
    expect((parsed.mode as { value: Sf941Token }).value).toEqual({ kind: "token", value: "live" });
  });

  it("parses Signature-Input components and keyid parameters", () => {
    const parsed = parseSf941Dict(
      "sig1=(\"@method\" \"@authority\" \"@path\" \"ucp-agent\");created=1618884473;keyid=\"platform-2026\""
    );
    const sig1 = parsed.sig1 as Sf941InnerList;
    expect(sig1.kind).toBe("inner-list");
    expect(sig1.value.map((item) => item.value)).toEqual(["@method", "@authority", "@path", "ucp-agent"]);
    expect(sig1.params).toEqual({ created: 1618884473, keyid: "platform-2026" });
  });
});

describe("RFC 8785 JCS canonicalization", () => {
  it("returns canonical UTF-8 bytes", () => {
    expect(text(jcsCanonicalize({ time: "2019-01-28T07:45:10Z", big: "055", val: 3.5 }))).toBe(
      "{\"big\":\"055\",\"time\":\"2019-01-28T07:45:10Z\",\"val\":3.5}"
    );
  });
});

describe("ECDSA raw signatures", () => {
  it("verifies RFC 6979 P-256 and P-384 known raw signatures", async () => {
    await expect(
      ecdsaVerifyRaw({
        algorithm: "ES256",
        publicKeyJwk: rfc6979P256.publicJwk,
        data: Buffer.from("sample", "utf8"),
        signature: hex(
          "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716" +
            "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8"
        )
      })
    ).resolves.toBe(true);

    await expect(
      ecdsaVerifyRaw({
        algorithm: "ES384",
        publicKeyJwk: rfc6979P384.publicJwk,
        data: Buffer.from("sample", "utf8"),
        signature: hex(
          "94EDBB92A5ECB8AAD4736E56C691916B3F88140666CE9FA73D64C4EA95AD133C" +
            "81A648152E44ACF96E36DD1E80FABE46" +
            "99EF4AEB15F178CEA1FE40DB2603138F130E740A19624526203B6351D0A3A94F" +
            "A329C145786E679E7B82C71A38628AC8"
        )
      })
    ).resolves.toBe(true);
  });

  it("signs as fixed-width raw r||s and verifies on both supported curves", async () => {
    const p256 = await ecdsaSignRaw({
      algorithm: "ES256",
      privateKeyJwk: rfc6979P256.privateJwk,
      data: Buffer.from("steelyard", "utf8")
    });
    expect(p256).toHaveLength(64);
    expect(looksLikeDerEcdsaSignature(p256)).toBe(false);
    await expect(
      ecdsaVerifyRaw({
        algorithm: "ES256",
        publicKeyJwk: rfc6979P256.publicJwk,
        data: Buffer.from("steelyard", "utf8"),
        signature: p256
      })
    ).resolves.toBe(true);

    const p384 = await ecdsaSignRaw({
      algorithm: "ES384",
      privateKeyJwk: rfc6979P384.privateJwk,
      data: Buffer.from("steelyard", "utf8")
    });
    expect(p384).toHaveLength(96);
    expect(looksLikeDerEcdsaSignature(p384)).toBe(false);
    await expect(
      ecdsaVerifyRaw({
        algorithm: "ES384",
        publicKeyJwk: rfc6979P384.publicJwk,
        data: Buffer.from("steelyard", "utf8"),
        signature: p384
      })
    ).resolves.toBe(true);
  });
});

describe("EC JWK validation", () => {
  it("accepts valid public P-256 and P-384 signing keys", () => {
    expect(assertValidEcJwk(rfc6979P256.publicJwk)).toEqual(rfc6979P256.publicJwk);
    expect(assertValidEcJwk(rfc6979P384.publicJwk)).toEqual(rfc6979P384.publicJwk);
  });

  it("accepts private d only when explicitly allowed", () => {
    expect(assertValidEcJwk(rfc6979P256.privateJwk, { allowPrivate: true })).toEqual(rfc6979P256.privateJwk);
    expect(() => assertValidEcJwk(rfc6979P256.privateJwk)).toThrow(/private d/);
  });

  it("rejects malformed or non-UCP EC keys", () => {
    expect(() => assertValidEcJwk({ ...rfc6979P256.publicJwk, kid: "" })).toThrow(/kid/);
    expect(() => assertValidEcJwk({ ...rfc6979P256.publicJwk, crv: "P-521" })).toThrow(/P-256 or P-384/);
    expect(() => assertValidEcJwk({ ...rfc6979P256.publicJwk, alg: "ES384" })).toThrow(/ES256/);
    expect(() => assertValidEcJwk({ ...rfc6979P256.publicJwk, x: "not+base64" })).toThrow(/base64url/);
    expect(() => assertValidEcJwk({ ...rfc6979P256.publicJwk, x: b64urlHex("01") })).toThrow(/32 bytes/);
    expect(() => assertValidEcJwk({ ...rfc6979P256.publicJwk, use: "enc" })).toThrow(/use/);
    expect(() => assertValidEcJwk({ ...rfc6979P256.publicJwk, k: "secret" })).toThrow(/private k/);
  });
});

describe("UCP error envelope types", () => {
  it("keeps the UCP REST envelope distinct from the v0.4 HTTP API envelope", () => {
    const ucp: UcpErrorEnvelope = {
      code: "signature_invalid",
      content: "Request signature verification failed for key kid=platform-2026"
    };
    const v04: V04ErrorEnvelope = {
      error: {
        code: "not_found",
        message: "Not found",
        details: { path: "/commerce/products" }
      }
    };

    expect(ucp).toEqual({
      code: "signature_invalid",
      content: "Request signature verification failed for key kid=platform-2026"
    });
    expect(ucp).not.toHaveProperty("error");
    expect(v04).toHaveProperty("error.message", "Not found");
  });
});

describe("detached JWS helpers", () => {
  it("signs and verifies RFC 7515 Appendix F compact detached content shape", async () => {
    const payload = jcsCanonicalize({ checkout: "chk_123", amount: 500 });
    const jws = await signDetachedJws({
      payload,
      header: { alg: "ES256", kid: "p256" },
      privateKey: { ...rfc6979P256.privateJwk, kid: "p256" }
    });

    expect(jws.split(".")).toHaveLength(3);
    expect(jws.split(".")[1]).toBe("");
    await expect(
      verifyDetachedJws({
        jws,
        payload,
        resolveKey: async (kid, alg) => (kid === "p256" && alg === "ES256" ? rfc6979P256.publicJwk : null)
      })
    ).resolves.toEqual({ ok: true, kid: "p256", alg: "ES256" });

    await expect(
      verifyDetachedJws({
        jws,
        payload: jcsCanonicalize({ checkout: "chk_123", amount: 501 }),
        resolveKey: async () => rfc6979P256.publicJwk
      })
    ).resolves.toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects malformed detached JWS inputs with stable reasons", async () => {
    const payload = jcsCanonicalize({ checkout: "chk_123" });
    const badJsonHeader = `${Buffer.from("not-json", "utf8").toString("base64url")}..${Buffer.from("sig").toString("base64url")}`;
    const badAlgorithm = `${base64urlJson({ alg: "ES512", kid: "p256" })}..${Buffer.from("sig").toString("base64url")}`;
    const missingKey = `${base64urlJson({ alg: "ES256", kid: "missing" })}..${Buffer.from("sig").toString("base64url")}`;

    await expect(
      verifyDetachedJws({
        jws: "not.detached.payload",
        payload,
        resolveKey: async () => rfc6979P256.publicJwk
      })
    ).resolves.toEqual({ ok: false, reason: "invalid_jws" });
    await expect(
      verifyDetachedJws({
        jws: badJsonHeader,
        payload,
        resolveKey: async () => rfc6979P256.publicJwk
      })
    ).resolves.toEqual({ ok: false, reason: "invalid_jws" });
    await expect(
      verifyDetachedJws({
        jws: badAlgorithm,
        payload,
        resolveKey: async () => rfc6979P256.publicJwk
      })
    ).resolves.toEqual({ ok: false, reason: "invalid_header" });
    await expect(
      verifyDetachedJws({
        jws: missingKey,
        payload,
        resolveKey: async () => null
      })
    ).resolves.toEqual({ ok: false, reason: "key_not_found" });
  });
});

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function hex(value: string): Uint8Array {
  return Buffer.from(value, "hex");
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function looksLikeDerEcdsaSignature(value: Uint8Array): boolean {
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 8 || bytes[0] !== 0x30) return false;
  const sequence = readDerLengthPrefix(bytes, 1);
  if (!sequence || sequence.offset + sequence.length !== bytes.byteLength) return false;
  const r = readDerIntegerPrefix(bytes, sequence.offset);
  if (!r) return false;
  const s = readDerIntegerPrefix(bytes, r.offset);
  return Boolean(s && s.offset === bytes.byteLength);
}

function readDerIntegerPrefix(bytes: Buffer, offset: number): { offset: number } | undefined {
  if (bytes[offset] !== 0x02) return undefined;
  const length = readDerLengthPrefix(bytes, offset + 1);
  if (!length) return undefined;
  const end = length.offset + length.length;
  if (length.length === 0 || end > bytes.byteLength) return undefined;
  return { offset: end };
}

function readDerLengthPrefix(bytes: Buffer, offset: number): { length: number; offset: number } | undefined {
  const first = bytes[offset];
  if (first === undefined) return undefined;
  if ((first & 0x80) === 0) return { length: first, offset: offset + 1 };
  const size = first & 0x7f;
  if (size === 0 || size > 4 || offset + size >= bytes.byteLength) return undefined;
  let length = 0;
  for (let index = 0; index < size; index += 1) {
    const next = bytes[offset + 1 + index];
    if (next === undefined) return undefined;
    length = (length << 8) | next;
  }
  return { length, offset: offset + 1 + size };
}

const rfc6979P256 = {
  publicJwk: {
    kid: "p256",
    kty: "EC",
    crv: "P-256",
    x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
    y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
    use: "sig",
    alg: "ES256"
  },
  privateJwk: {
    kid: "p256",
    kty: "EC",
    crv: "P-256",
    x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
    y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
    d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721"),
    use: "sig",
    alg: "ES256"
  }
} satisfies { publicJwk: EcJwk; privateJwk: EcJwk };

const rfc6979P384 = {
  publicJwk: {
    kid: "p384",
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
  },
  privateJwk: {
    kid: "p384",
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
    d: b64urlHex("6B9D3DAD2E1B8C1C05B19875B6659F4DE23C3B667BF297BA9AA47740787137D8" + "96D5724E4C70A825F872C9EA60D2EDF5"),
    use: "sig",
    alg: "ES384"
  }
} satisfies { publicJwk: EcJwk; privateJwk: EcJwk };
