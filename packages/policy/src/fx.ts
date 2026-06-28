export interface FxQuote {
  id: string;
  ts: string;
  src: string;
  dst: string;
  rate: number;
  source: string;
}

export interface FxQuoteService {
  quote(src: string, dst: string): Promise<FxQuote>;
}

export interface EcbFxQuoteServiceOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface EcbRates {
  asOf: string;
  rates: Map<string, number>;
}

const ECB_DAILY_ENDPOINT = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/** Test/dev service: rate table + injectable clock. Caches per UTC minute. */
export class InMemoryFxQuoteService implements FxQuoteService {
  private readonly cache = new Map<string, FxQuote>();

  constructor(
    private readonly rates: Record<string, number>,
    private readonly now: () => Date
  ) {}

  async quote(src: string, dst: string): Promise<FxQuote> {
    const source = normalizeCurrency(src);
    const target = normalizeCurrency(dst);
    if (source === target) {
      return { id: "fxq_identity", ts: this.now().toISOString(), src: source, dst: target, rate: 1, source: "identity" };
    }

    const key = `${source}/${target}`;
    const rate = this.rates[key];
    if (rate === undefined) throw new Error(`no rate for ${key}`);
    const minuteKey = `${key}@${this.now().toISOString().slice(0, 16)}`;
    const cached = this.cache.get(minuteKey);
    if (cached) return cached;

    const fresh: FxQuote = {
      id: `fxq_${minuteKey.replace(/[^A-Za-z0-9]/g, "_")}`,
      ts: this.now().toISOString(),
      src: source,
      dst: target,
      rate,
      source: "in_memory"
    };
    this.cache.set(minuteKey, fresh);
    return fresh;
  }
}

export class EcbFxQuoteService implements FxQuoteService {
  private cache?: EcbRates;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: EcbFxQuoteServiceOptions = {}) {
    this.endpoint = opts.endpoint ?? ECB_DAILY_ENDPOINT;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  async quote(src: string, dst: string): Promise<FxQuote> {
    const source = normalizeCurrency(src);
    const target = normalizeCurrency(dst);
    if (source === target) {
      return { id: "fxq_identity", ts: this.now().toISOString(), src: source, dst: target, rate: 1, source: "identity" };
    }

    const ecb = await this.rates();
    const rate = ecbRate(ecb.rates, source, target);
    return {
      id: `fxq_ecb_${ecb.asOf}_${source}_${target}`,
      ts: this.now().toISOString(),
      src: source,
      dst: target,
      rate,
      source: "ecb_daily_reference"
    };
  }

  private async rates(): Promise<EcbRates> {
    if (this.cache) return this.cache;

    const response = await this.fetchImpl(this.endpoint);
    if (!response.ok) throw new Error(`ECB FX fetch failed HTTP ${response.status}`);
    const body = await response.text();
    this.cache = parseEcbDailyRates(body);
    return this.cache;
  }
}

export function parseEcbDailyRates(xml: string): EcbRates {
  const time = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!time) throw new Error("ECB FX response missing daily rate date");

  const rates = new Map<string, number>([["EUR", 1]]);
  const cubePattern = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g;
  for (const match of xml.matchAll(cubePattern)) {
    const [, currency, value] = match;
    if (!currency || !value) continue;
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`ECB FX response has invalid rate for ${currency}`);
    rates.set(currency, rate);
  }

  if (rates.size <= 1) throw new Error("ECB FX response did not include currency rates");
  return { asOf: time, rates };
}

function ecbRate(rates: Map<string, number>, src: string, dst: string): number {
  const srcRate = rates.get(src);
  const dstRate = rates.get(dst);
  if (srcRate === undefined) throw new Error(`ECB FX response has no rate for ${src}`);
  if (dstRate === undefined) throw new Error(`ECB FX response has no rate for ${dst}`);
  return dstRate / srcRate;
}

function normalizeCurrency(currency: string): string {
  if (!/^[a-zA-Z]{3}$/.test(currency)) throw new Error(`invalid currency: ${currency}`);
  return currency.toUpperCase();
}
