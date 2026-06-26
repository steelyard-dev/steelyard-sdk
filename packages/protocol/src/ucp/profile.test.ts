// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it, vi } from "vitest";
import type { EcJwk } from "@steelyard/core";
import type { UcpProfileDoc } from "./discovery.js";
import {
  UCP_PROFILE_MAX_BYTES,
  UcpProfileCache,
  fetchUcpProfile,
  resolveSigningKey
} from "./profile.js";

describe("fetchUcpProfile", () => {
  it("fetches HTTPS profiles without redirects and validates the profile body", async () => {
    const fetch = vi.fn(async () => jsonResponse(profile([merchantP256PublicKey]), { "cache-control": "public, max-age=120" }));

    const result = await fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch,
      lookup: publicLookup
    });

    expect(result.signing_keys?.[0]?.kid).toBe("merchant-p256");
    expect(fetch).toHaveBeenCalledWith(new URL("https://profile.example/.well-known/ucp"), expect.objectContaining({
      redirect: "manual"
    }));
  });

  it("allows loopback HTTP only when private-network access is explicit", async () => {
    const fetch = vi.fn(async () => jsonResponse(profile([merchantP256PublicKey])));

    await expect(fetchUcpProfile("http://127.0.0.1:8787/.well-known/ucp", {
      fetch,
      allowPrivateNetwork: true
    })).resolves.toMatchObject({ signing_keys: [expect.objectContaining({ kid: "merchant-p256" })] });
    await expect(fetchUcpProfile("http://shop.example/.well-known/ucp", {
      fetch,
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileScheme" });
    await expect(fetchUcpProfile("http://10.0.0.1/.well-known/ucp", {
      fetch,
      allowPrivateNetwork: false
    })).rejects.toMatchObject({ code: "Ucp.ProfileScheme" });
    await expect(fetchUcpProfile("ftp://profile.example/.well-known/ucp", {
      fetch,
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileScheme" });
    await expect(fetchUcpProfile("not a url", {
      fetch,
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileScheme" });
  });

  it("rejects private-network HTTPS profiles unless private-network access is explicit", async () => {
    const fetch = vi.fn(async () => jsonResponse(profile([merchantP256PublicKey])));

    await expect(fetchUcpProfile("https://private.example/.well-known/ucp", {
      fetch,
      lookup: async () => [{ address: "10.0.0.1" }]
    })).rejects.toMatchObject({ code: "Ucp.ProfilePrivateNetwork" });
    await expect(fetchUcpProfile("https://private.example/.well-known/ucp", {
      fetch,
      lookup: async () => [{ address: "10.0.0.1" }],
      allowPrivateNetwork: true
    })).resolves.toMatchObject({ signing_keys: [expect.objectContaining({ kid: "merchant-p256" })] });
    await expect(fetchUcpProfile("https://93.184.216.34/.well-known/ucp", {
      fetch,
      lookup: publicLookup
    })).resolves.toMatchObject({ signing_keys: [expect.objectContaining({ kid: "merchant-p256" })] });
  });

  it("rejects redirects, oversized bodies, and timeouts", async () => {
    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn(async () => new Response("", { status: 302, headers: { location: "https://elsewhere.example" } })),
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileRedirect" });

    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn(async () => new Response("", { status: 500 })),
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileHttp" });

    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn(async () => new Response("{")),
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileInvalid" });

    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn(async () => new Response(null)),
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileInvalid" });

    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn(async () => {
        throw new Error("network down");
      }),
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileUnreachable" });

    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn(async () => jsonResponse(profile([merchantP256PublicKey]))),
      lookup: async () => {
        throw new Error("dns failed");
      }
    })).rejects.toMatchObject({ code: "Ucp.ProfileUnreachable" });

    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn(async () => new Response("x".repeat(UCP_PROFILE_MAX_BYTES + 1))),
      lookup: publicLookup
    })).rejects.toMatchObject({ code: "Ucp.ProfileTooLarge" });

    await expect(fetchUcpProfile("https://profile.example/.well-known/ucp", {
      fetch: vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
      lookup: publicLookup,
      timeoutMs: 1
    })).rejects.toMatchObject({ code: "Ucp.ProfileTimeout" });
  });
});

describe("UcpProfileCache", () => {
  it("caches profiles by URL using the Cache-Control TTL window", async () => {
    let nowMs = Date.parse("2026-06-15T00:00:00.000Z");
    const fetch = vi.fn(async () => jsonResponse(profile([merchantP256PublicKey]), { "cache-control": "public, max-age=120" }));
    const cache = new UcpProfileCache();
    const opts = { fetch, lookup: publicLookup, now: () => new Date(nowMs) };

    await expect(cache.get("https://profile.example/.well-known/ucp", opts)).resolves.toMatchObject({
      signing_keys: [expect.objectContaining({ kid: "merchant-p256" })]
    });
    await cache.get("https://profile.example/.well-known/ucp", opts);
    expect(fetch).toHaveBeenCalledTimes(1);

    nowMs += 121_000;
    await cache.get("https://profile.example/.well-known/ucp", opts);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("floors profile cache TTL at 60 seconds and caps it at 1 hour", async () => {
    let nowMs = Date.parse("2026-06-15T00:00:00.000Z");
    const shortFetch = vi.fn(async () => jsonResponse(profile([merchantP256PublicKey]), { "cache-control": "public, max-age=1" }));
    const shortCache = new UcpProfileCache();
    const shortOpts = { fetch: shortFetch, lookup: publicLookup, now: () => new Date(nowMs) };

    await shortCache.get("https://short.example/.well-known/ucp", shortOpts);
    nowMs += 59_000;
    await shortCache.get("https://short.example/.well-known/ucp", shortOpts);
    expect(shortFetch).toHaveBeenCalledTimes(1);
    nowMs += 2_000;
    await shortCache.get("https://short.example/.well-known/ucp", shortOpts);
    expect(shortFetch).toHaveBeenCalledTimes(2);

    nowMs = Date.parse("2026-06-15T00:00:00.000Z");
    const longFetch = vi.fn(async () => jsonResponse(profile([merchantP256PublicKey]), { "cache-control": "public, max-age=7200" }));
    const longCache = new UcpProfileCache();
    const longOpts = { fetch: longFetch, lookup: publicLookup, now: () => new Date(nowMs) };

    await longCache.get("https://long.example/.well-known/ucp", longOpts);
    nowMs += 3_599_000;
    await longCache.get("https://long.example/.well-known/ucp", longOpts);
    expect(longFetch).toHaveBeenCalledTimes(1);
    nowMs += 2_000;
    await longCache.get("https://long.example/.well-known/ucp", longOpts);
    expect(longFetch).toHaveBeenCalledTimes(2);
  });

  it("forces exactly one refresh for an unknown kid within a TTL window", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(profile([merchantP256PublicKey]), { "cache-control": "public, max-age=120" }))
      .mockResolvedValueOnce(jsonResponse(profile([merchantP384PublicKey]), { "cache-control": "public, max-age=120" }));
    const cache = new UcpProfileCache();

    const key = await cache.resolveSigningKey("https://profile.example/.well-known/ucp", "merchant-p384", {
      fetch,
      lookup: publicLookup,
      now: () => new Date("2026-06-15T00:00:00.000Z")
    });

    expect(key?.kid).toBe("merchant-p384");
    await expect(cache.resolveSigningKey("https://profile.example/.well-known/ucp", "merchant-p384", {
      fetch,
      lookup: publicLookup,
      now: () => new Date("2026-06-15T00:00:30.000Z")
    })).resolves.toMatchObject({ kid: "merchant-p384" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not repeatedly refetch for a kid still missing after forced refresh", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse(profile([merchantP256PublicKey]), { "cache-control": "public, max-age=120" }));
    const cache = new UcpProfileCache();
    const opts = {
      fetch,
      lookup: publicLookup,
      now: () => new Date("2026-06-15T00:00:00.000Z")
    };

    await expect(cache.resolveSigningKey("https://profile.example/.well-known/ucp", "missing", opts)).resolves.toBeNull();
    await expect(cache.resolveSigningKey("https://profile.example/.well-known/ucp", "missing", opts)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("resolveSigningKey", () => {
  it("matches keyid to signing_keys kid by exact string equality", () => {
    const doc = profile([merchantP256PublicKey]);

    expect(resolveSigningKey(doc, "merchant-p256")?.kid).toBe("merchant-p256");
    expect(resolveSigningKey(doc, "MERCHANT-P256")).toBeNull();
    expect(resolveSigningKey(doc, "merchant-p256 ")).toBeNull();
  });
});

function profile(signingKeys: EcJwk[]): UcpProfileDoc {
  return {
    ucp: { version: "2026-04-17" },
    signing_keys: signingKeys
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers });
}

function publicLookup(): Promise<readonly { address: string }[]> {
  return Promise.resolve([{ address: "93.184.216.34" }]);
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
