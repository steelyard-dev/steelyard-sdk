import { setTimeout as delay } from "node:timers/promises";
import type {
  X402FacilitatorClient,
  X402FacilitatorClientOptions,
  X402IdempotencyStore,
  X402SettleResult,
  X402VerifyResult
} from "./types.js";

export function createX402FacilitatorClient(opts: string | X402FacilitatorClientOptions): X402FacilitatorClient {
  const options = typeof opts === "string" ? { baseUrl: opts } : opts;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("global fetch is unavailable; pass facilitator fetch");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");

  return {
    verify: async (args) => requestJson<X402VerifyResult>(fetchImpl, `${baseUrl}/verify`, args, timeoutMs),
    settle: async (args) => requestJson<X402SettleResult>(fetchImpl, `${baseUrl}/settle`, args, timeoutMs)
  };
}

export function memoryX402IdempotencyStore(): X402IdempotencyStore {
  const settled = new Map<string, X402SettleResult>();
  return {
    async get(key) {
      return settled.get(key);
    },
    async set(key, value) {
      settled.set(key, value);
    }
  };
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
    controller.abort(new Error(`x402 facilitator request timed out after ${timeoutMs}ms`));
  }).catch(() => undefined);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`x402 facilitator ${url} returned ${response.status}`);
    return await response.json() as T;
  } finally {
    controller.abort();
    await timeout;
  }
}
