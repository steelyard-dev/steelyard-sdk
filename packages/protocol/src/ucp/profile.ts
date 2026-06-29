// Copyright (c) Steelyard contributors. MIT License.
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { assertValidEcJwk, defaultClock, type EcJwk } from "@steelyard-dev/core";
import { assertValidUcpProfile, type UcpProfileDoc } from "./discovery.js";

export const UCP_PROFILE_MAX_BYTES = 1024 * 1024;
export const UCP_PROFILE_MIN_TTL_MS = 60_000;
export const UCP_PROFILE_MAX_TTL_MS = 3_600_000;

export type UcpProfileFetchErrorCode =
  | "Ucp.ProfileScheme"
  | "Ucp.ProfilePrivateNetwork"
  | "Ucp.ProfileRedirect"
  | "Ucp.ProfileTimeout"
  | "Ucp.ProfileTooLarge"
  | "Ucp.ProfileHttp"
  | "Ucp.ProfileInvalid"
  | "Ucp.ProfileUnreachable";

export class UcpProfileFetchError extends Error {
  constructor(
    readonly code: UcpProfileFetchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UcpProfileFetchError";
  }
}

export interface FetchUcpProfileOptions {
  allowPrivateNetwork?: boolean;
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<readonly { address: string }[]>;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface UcpProfileCacheOptions extends FetchUcpProfileOptions {
  now?: () => Date;
}

interface FetchedProfile {
  profile: UcpProfileDoc;
  ttlMs: number;
}

interface CachedProfile {
  profile: UcpProfileDoc;
  expiresAtMs: number;
}

export class UcpProfileCache {
  readonly #entries = new Map<string, CachedProfile>();
  readonly #forcedRefreshBlockedUntil = new Map<string, number>();

  async get(profileUrl: string | URL, opts: UcpProfileCacheOptions = {}): Promise<UcpProfileDoc> {
    return (await this.getEntry(profileUrl, opts)).profile;
  }

  async resolveSigningKey(profileUrl: string | URL, kid: string, opts: UcpProfileCacheOptions = {}): Promise<EcJwk | null> {
    const key = normalizeProfileUrl(profileUrl);
    const nowMs = currentTimeMs(opts);
    const entry = await this.getEntry(key, opts);
    const cachedKey = resolveSigningKey(entry.profile, kid);
    if (cachedKey) return cachedKey;

    const blockedUntil = this.#forcedRefreshBlockedUntil.get(key) ?? 0;
    if (blockedUntil > nowMs) return null;

    this.#forcedRefreshBlockedUntil.set(key, entry.expiresAtMs);
    const refreshed = await this.fetchAndStore(key, opts);
    return resolveSigningKey(refreshed.profile, kid);
  }

  private async getEntry(profileUrl: string | URL, opts: UcpProfileCacheOptions): Promise<CachedProfile> {
    const key = normalizeProfileUrl(profileUrl);
    const nowMs = currentTimeMs(opts);
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAtMs > nowMs) return cached;
    return await this.fetchAndStore(key, opts);
  }

  private async fetchAndStore(profileUrl: string, opts: UcpProfileCacheOptions): Promise<CachedProfile> {
    const fetched = await fetchUcpProfileWithMeta(profileUrl, opts);
    const entry = {
      profile: fetched.profile,
      expiresAtMs: currentTimeMs(opts) + fetched.ttlMs
    };
    this.#entries.set(profileUrl, entry);
    return entry;
  }
}

export async function fetchUcpProfile(profileUrl: string | URL, opts: FetchUcpProfileOptions = {}): Promise<UcpProfileDoc> {
  return (await fetchUcpProfileWithMeta(profileUrl, opts)).profile;
}

export function resolveSigningKey(profile: UcpProfileDoc, kid: string): EcJwk | null {
  for (const key of profile.signing_keys ?? []) {
    if (key.kid === kid) return assertValidEcJwk(key);
  }
  return null;
}

async function fetchUcpProfileWithMeta(profileUrl: string | URL, opts: FetchUcpProfileOptions): Promise<FetchedProfile> {
  const url = parseProfileUrl(profileUrl);
  await assertProfileUrlAllowed(url, opts);

  const timeoutMs = opts.timeoutMs ?? profileTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await (opts.fetch ?? fetch)(url, { redirect: "manual", signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new UcpProfileFetchError("Ucp.ProfileTimeout", `profile fetch timed out after ${timeoutMs} ms`);
    }
    throw new UcpProfileFetchError("Ucp.ProfileUnreachable", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UcpProfileFetchError("Ucp.ProfileRedirect", `profile fetch rejected redirect HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new UcpProfileFetchError("Ucp.ProfileHttp", `profile fetch failed HTTP ${response.status}`);
  }

  const raw = await readBoundedText(response, opts.maxBytes ?? UCP_PROFILE_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    assertValidUcpProfile(parsed);
  } catch (error) {
    throw new UcpProfileFetchError("Ucp.ProfileInvalid", error instanceof Error ? error.message : String(error));
  }

  return {
    profile: parsed,
    ttlMs: profileCacheTtlMs(response.headers.get("cache-control"))
  };
}

async function assertProfileUrlAllowed(url: URL, opts: FetchUcpProfileOptions): Promise<void> {
  if (url.protocol === "http:") {
    if (opts.allowPrivateNetwork && isLoopbackHost(url.hostname)) return;
    throw new UcpProfileFetchError("Ucp.ProfileScheme", "UCP profiles must be fetched over HTTPS");
  }
  if (url.protocol !== "https:") {
    throw new UcpProfileFetchError("Ucp.ProfileScheme", `unsupported UCP profile URL scheme: ${url.protocol}`);
  }
  if (opts.allowPrivateNetwork) return;

  const hostname = normalizedHostname(url.hostname);
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await (opts.lookup ?? defaultLookup)(hostname).catch((error) => {
        throw new UcpProfileFetchError("Ucp.ProfileUnreachable", error instanceof Error ? error.message : String(error));
      });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UcpProfileFetchError("Ucp.ProfilePrivateNetwork", `refusing private-network UCP profile URL: ${url.hostname}`);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > maxBytes) {
        throw new UcpProfileFetchError("Ucp.ProfileTooLarge", `profile response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function profileCacheTtlMs(cacheControl: string | null): number {
  const maxAge = cacheControl?.match(/(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i)?.[1];
  const seconds = maxAge ? Number(maxAge) : 60;
  if (!Number.isFinite(seconds) || seconds <= 0) return UCP_PROFILE_MIN_TTL_MS;
  return Math.min(UCP_PROFILE_MAX_TTL_MS, Math.max(UCP_PROFILE_MIN_TTL_MS, seconds * 1000));
}

function profileTimeoutMs(): number {
  const raw = process.env.STEELYARD_UCP_PROFILE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

function parseProfileUrl(profileUrl: string | URL): URL {
  try {
    return profileUrl instanceof URL ? profileUrl : new URL(profileUrl);
  } catch {
    throw new UcpProfileFetchError("Ucp.ProfileScheme", `malformed UCP profile URL: ${String(profileUrl)}`);
  }
}

function normalizeProfileUrl(profileUrl: string | URL): string {
  return parseProfileUrl(profileUrl).href;
}

function currentTimeMs(opts: UcpProfileCacheOptions): number {
  return defaultClock(opts.now)().getTime();
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizedHostname(hostname).toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function defaultLookup(hostname: string): Promise<readonly { address: string }[]> {
  return dns.lookup(hostname, { all: true });
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map((part) => Number(part));
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("fc") || lower.startsWith("fd");
}
