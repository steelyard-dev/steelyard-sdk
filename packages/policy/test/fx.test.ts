import { describe, expect, it, vi } from "vitest";
import { EcbFxQuoteService, InMemoryFxQuoteService, parseEcbDailyRates, type FxQuote } from "../src/fx.js";

const ECB_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope>
  <Cube>
    <Cube time="2026-06-26">
      <Cube currency="USD" rate="1.1700"/>
      <Cube currency="GBP" rate="0.8500"/>
      <Cube currency="JPY" rate="180.00"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("InMemoryFxQuoteService", () => {
  it("returns a quote with id, ts, rate, source", async () => {
    const fx = new InMemoryFxQuoteService({ "EUR/USD": 1.08 }, () => new Date("2026-06-28T12:00:00Z"));
    const q: FxQuote = await fx.quote("EUR", "USD");
    expect(q.rate).toBe(1.08);
    expect(q.source).toBe("in_memory");
    expect(q.ts).toBe("2026-06-28T12:00:00.000Z");
    expect(q.id).toMatch(/^fxq_/);
  });

  it("rates are stable across two reads of the same minute", async () => {
    const fx = new InMemoryFxQuoteService({ "EUR/USD": 1.08 }, () => new Date("2026-06-28T12:00:00Z"));
    const a = await fx.quote("EUR", "USD");
    const b = await fx.quote("EUR", "USD");
    expect(a.id).toBe(b.id);
  });

  it("returns identity quotes without reading a rate table", async () => {
    const fx = new InMemoryFxQuoteService({}, () => new Date("2026-06-28T12:00:00Z"));
    await expect(fx.quote("usd", "USD")).resolves.toMatchObject({ id: "fxq_identity", rate: 1, source: "identity" });
  });

  it("throws on unknown pair", async () => {
    const fx = new InMemoryFxQuoteService({}, () => new Date());
    await expect(fx.quote("EUR", "USD")).rejects.toThrow(/no rate/);
  });
});

describe("EcbFxQuoteService", () => {
  it("parses ECB daily rates", () => {
    const parsed = parseEcbDailyRates(ECB_FIXTURE);
    expect(parsed.asOf).toBe("2026-06-26");
    expect(parsed.rates.get("EUR")).toBe(1);
    expect(parsed.rates.get("USD")).toBe(1.17);
  });

  it("quotes EUR to foreign currency from ECB daily reference data", async () => {
    const service = new EcbFxQuoteService({ fetch: fakeFetch(ECB_FIXTURE), now: () => new Date("2026-06-28T12:00:00Z") });
    await expect(service.quote("EUR", "USD")).resolves.toEqual({
      id: "fxq_ecb_2026-06-26_EUR_USD",
      ts: "2026-06-28T12:00:00.000Z",
      src: "EUR",
      dst: "USD",
      rate: 1.17,
      source: "ecb_daily_reference"
    });
  });

  it("quotes cross rates via EUR and caches fetched ECB data", async () => {
    const fetch = fakeFetch(ECB_FIXTURE);
    const service = new EcbFxQuoteService({ fetch, now: () => new Date("2026-06-28T12:00:00Z") });
    const usdToGbp = await service.quote("USD", "GBP");
    const gbpToEur = await service.quote("GBP", "EUR");
    expect(usdToGbp.rate).toBeCloseTo(0.85 / 1.17);
    expect(gbpToEur.rate).toBeCloseTo(1 / 0.85);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns identity quotes without fetching ECB data", async () => {
    const fetch = fakeFetch(ECB_FIXTURE);
    const service = new EcbFxQuoteService({ fetch, now: () => new Date("2026-06-28T12:00:00Z") });
    await expect(service.quote("EUR", "eur")).resolves.toMatchObject({ id: "fxq_identity", rate: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects missing currencies and malformed ECB responses", async () => {
    const service = new EcbFxQuoteService({ fetch: fakeFetch(ECB_FIXTURE) });
    await expect(service.quote("USD", "AUD")).rejects.toThrow(/no rate for AUD/);
    expect(() => parseEcbDailyRates("<Cube></Cube>")).toThrow(/missing daily rate date/);
    expect(() => parseEcbDailyRates('<Cube time="2026-06-26"></Cube>')).toThrow(/did not include currency rates/);
    expect(() => parseEcbDailyRates('<Cube time="2026-06-26"><Cube currency="USD" rate="0"/></Cube>')).toThrow(
      /invalid rate/
    );
  });

  it("rejects invalid currencies and HTTP failures", async () => {
    const service = new EcbFxQuoteService({ fetch: fakeFetch(ECB_FIXTURE) });
    await expect(service.quote("EURO", "USD")).rejects.toThrow(/invalid currency/);
    await expect(new EcbFxQuoteService({ fetch: fakeFetch("", { ok: false, status: 503 }) }).quote("EUR", "USD")).rejects.toThrow(
      /HTTP 503/
    );
  });
});

function fakeFetch(body: string, opts: { ok?: boolean; status?: number } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => body
  })) as unknown as typeof fetch;
}
