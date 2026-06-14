import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  COMMERCE_READ_VERSION,
  canonicalMerchantAudience,
  defineCommerce,
  type ApprovalProof,
  type ApprovalResume,
  type ErrorCode,
  type Manifest,
  type Offer,
  type Policies,
  type Policy,
  type PurchaseIntent,
  type Receipt,
  type WalletDriverPort
} from "@steelyard/core";
import {
  STEELYARD_DOMAIN,
  STEELYARD_MANDATE_V01_ID,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY_ID,
  UCP_CHECKOUT_CAPABILITY_ID,
  UCP_SHOPPING_DOMAIN,
  UCP_SHOPPING_SERVICE,
  UCP_WELL_KNOWN_PATH
} from "@steelyard/protocol/ucp";
import { acpDriver } from "./acp.js";
import { ucpDriver } from "./ucp.js";

export type Protocol = "mcp" | "acp" | "ucp";
export type MerchantCapability = "read" | "checkout" | "checkout:steelyard" | "discounts";

export interface SteelyardError {
  error: ErrorCode;
  error_detail?: string;
}

export interface ConnectOptions {
  delegatePaymentUrl?: string;
}

export interface PurchaseOpts {
  port: WalletDriverPort;
  approval?: ApprovalProof;
  resume?: ApprovalResume;
  idempotencyKey?: string;
  clock?: () => Date;
  onTotalsKnown?: (finalTotal: number, currency: string) => Promise<void> | void;
}

export interface Merchant {
  id: string;
  protocol: Protocol;
  url: string;
  supports(capability: MerchantCapability): boolean;
  search(query: string): Promise<Offer[] | SteelyardError>;
  lookup(id: string): Promise<Offer | SteelyardError>;
  getOffer(id: string): Promise<Offer | SteelyardError>;
  getManifest(): Promise<Manifest | SteelyardError>;
  getPolicies(): Promise<Policies | SteelyardError>;
  purchase(intent: PurchaseIntent, opts: PurchaseOpts): Promise<Receipt>;
  close?(): Promise<void>;
}

export class MerchantNoCheckout extends Error {
  readonly protocol: Protocol;
  readonly reason: string;

  constructor(opts: { protocol: Protocol; reason: string }) {
    super(opts.reason);
    this.name = "MerchantNoCheckout";
    this.protocol = opts.protocol;
    this.reason = opts.reason;
  }
}

type DetectionResult = Merchant | SteelyardError | undefined;

export const Steelyard = {
  connect
};

export async function connect(url: string, opts: ConnectOptions = {}): Promise<Merchant | SteelyardError> {
  const parsed = parseUrl(url);
  if ("error" in parsed) return parsed;

  const mcp = await detectMcp(parsed);
  if (mcp) return mcp;

  const acp = await detectAcp(parsed, opts);
  if (acp) return acp;

  const ucp = await detectUcp(parsed, opts);
  if (ucp) return ucp;

  return fail("protocol_mismatch", "Could not detect MCP, ACP, or UCP at the supplied URL.");
}

function parseUrl(url: string): URL | SteelyardError {
  try {
    return new URL(url);
  } catch (error) {
    return fail("network_error", (error as Error).message);
  }
}

async function detectMcp(url: URL): Promise<DetectionResult> {
  const client = new Client({ name: "steelyard-client", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const version = readMcpCommerceVersion(client);
    if (!version) {
      await client.close();
      return undefined;
    }
    if (!isCompatibleReadVersion(version)) {
      await client.close();
      return fail("version_mismatch", `Server read version ${version} is not compatible with ${COMMERCE_READ_VERSION}.`);
    }
    return mcpMerchant(client, url);
  } catch (error) {
    await closeQuietly(client);
    return isNetworkFailure(error) ? fail("network_error", (error as Error).message) : undefined;
  }
}

async function detectAcp(url: URL, opts: ConnectOptions): Promise<DetectionResult> {
  const feed = await fetchJson(url);
  if (isError(feed)) return feed.error === "network_error" ? feed : undefined;
  if (!isAcpFeed(feed)) return undefined;
  return acpMerchant(url, feed, opts);
}

async function detectUcp(url: URL, opts: ConnectOptions): Promise<DetectionResult> {
  const discoveryUrl = url.pathname.endsWith(UCP_WELL_KNOWN_PATH)
    ? url
    : new URL(UCP_WELL_KNOWN_PATH, url);
  const doc = await fetchJson(discoveryUrl);
  if (isError(doc)) return doc.error === "network_error" ? doc : undefined;
  if (!isUcpDiscovery(doc)) return undefined;
  return ucpMerchant(doc, discoveryUrl, opts);
}

function mcpMerchant(client: Client, url: URL): Merchant {
  const merchant: Merchant = {
    id: url.host,
    protocol: "mcp",
    url: url.toString(),
    supports(capability) {
      return capability === "read";
    },
    async search(query) {
      return mapCall(async () => {
        const result = await client.callTool({ name: "list_offers", arguments: { query } });
        if ("isError" in result && result.isError) throw new Error(toolText(result));
        return parseOffers(toolText(result));
      });
    },
    async getOffer(id) {
      return mapCall(async () => {
        const result = await client.callTool({ name: "get_offer", arguments: { id } });
        if ("isError" in result && result.isError) return fail("not_found", toolText(result));
        return parseOffer(toolText(result));
      });
    },
    async lookup(id) {
      return merchant.getOffer(id);
    },
    async getManifest() {
      return mapCall(async () => {
        const resource = await client.readResource({ uri: "commerce://manifest" });
        return JSON.parse(resourceText(resource)) as Manifest;
      }, "not_found");
    },
    async getPolicies() {
      return mapCall(async () => {
        const resource = await client.readResource({ uri: "commerce://policies" });
        return JSON.parse(resourceText(resource)) as Policies;
      }, "not_found");
    },
    async purchase() {
      throw new MerchantNoCheckout({
        protocol: "mcp",
        reason: "v0.3 does not support MCP checkout - deferred to v0.4"
      });
    },
    async close() {
      await closeQuietly(client);
    }
  };
  return merchant;
}

function acpMerchant(url: URL, initialFeed: unknown, config: ConnectOptions): Merchant {
  const loadOffers = async () => acpOffersFromFeed(isAcpFeed(initialFeed) ? initialFeed : await fetchJson(url), url);
  const loadPolicies = async () => acpPoliciesFromFeed(isAcpFeed(initialFeed) ? initialFeed : await fetchJson(url));
  const checkoutUrl = acpCheckoutBaseUrl(url).toString();
  const checkoutSupported = acpSupportsService(initialFeed, "checkout");
  const merchant: Merchant = {
    id: acpMerchantId(initialFeed, url),
    protocol: "acp",
    url: checkoutUrl,
    supports(capability) {
      if (capability === "read") return true;
      if (capability === "checkout") return checkoutSupported;
      if (capability === "checkout:steelyard") return false;
      if (capability === "discounts") return acpSupportsService(initialFeed, "discounts");
      return false;
    },
    async search(query) {
      return mapCall(async () => filterOffers(await loadOffers(), query));
    },
    async getOffer(id) {
      return mapCall(async () => findOffer(await loadOffers(), id));
    },
    async getManifest() {
      return mapCall(async () =>
        defineCommerce({
          identity: merchantIdentityFromAcp(isAcpFeed(initialFeed) ? initialFeed : await fetchJson(url), url),
          offers: await loadOffers(),
          policies: await loadPolicies()
        })
      );
    },
    async getPolicies() {
      return mapCall(loadPolicies);
    },
    async lookup(id) {
      return merchant.getOffer(id);
    },
    async purchase(intent, opts) {
      if (!checkoutSupported) {
        throw new MerchantNoCheckout({
          protocol: "acp",
          reason: "ACP discovery did not advertise checkout"
        });
      }
      return acpDriver.purchase(intent, {
        merchantId: merchant.id,
        merchantUrl: checkoutUrl,
        delegatePaymentUrl: config.delegatePaymentUrl,
        port: opts.port,
        idempotencyKey: opts.idempotencyKey,
        clock: opts.clock,
        onTotalsKnown: opts.onTotalsKnown
      });
    }
  };
  return merchant;
}

function ucpMerchant(doc: UcpDiscovery, discoveryUrl: URL, config: ConnectOptions): Merchant {
  const endpoint = restEndpoint(doc) ?? new URL("/api", discoveryUrl).toString();
  const identity = { name: doc.merchant?.name ?? discoveryUrl.host, domain: doc.merchant?.domain };
  const id = canonicalMerchantAudience({
    id: doc.merchant?.domain ?? discoveryUrl.host,
    protocol: "ucp",
    discoveryUrl: discoveryUrl.toString()
  });
  const checkoutSupported = ucpHasCapability(doc, UCP_SHOPPING_DOMAIN, UCP_CHECKOUT_CAPABILITY_ID);
  const post = (path: string, body: unknown) => fetchJson(new URL(`${endpoint.replace(/\/$/, "")}${path}`), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });

  const merchant: Merchant = {
    id,
    protocol: "ucp",
    url: endpoint,
    supports(capability) {
      if (capability === "read") return true;
      if (capability === "checkout") return checkoutSupported;
      if (capability === "checkout:steelyard") {
        return checkoutSupported && ucpHasCapability(doc, STEELYARD_DOMAIN, STEELYARD_MANDATE_V01_ID);
      }
      if (capability === "discounts") return false;
      return false;
    },
    async search(query) {
      return mapCall(async () => {
        const response = await post("/catalog/search", { query });
        if (isError(response)) return response;
        return ucpProductsToOffers((response as { products?: unknown[] }).products ?? []);
      });
    },
    async getOffer(id) {
      return mapCall(async () => {
        const response = await post("/catalog/product", { id });
        if (isError(response)) return response.error === "network_error" ? response : fail("not_found", response.error_detail);
        const product = (response as { product?: unknown }).product;
        if (!product) return fail("not_found", `Offer not found: ${id}`);
        return ucpProductToOffer(product);
      });
    },
    async lookup(id) {
      return merchant.getOffer(id);
    },
    async getManifest() {
      return mapCall(async () => {
        const response = await post("/catalog/search", {});
        if (isError(response)) return response;
        return defineCommerce({ identity, offers: ucpProductsToOffers((response as { products?: unknown[] }).products ?? []) });
      });
    },
    async getPolicies() {
      return [];
    },
    async purchase(intent, opts) {
      if (!checkoutSupported) {
        throw new MerchantNoCheckout({
          protocol: "ucp",
          reason: "UCP discovery did not advertise checkout"
        });
      }
      return ucpDriver.purchase(intent, {
        merchantId: merchant.id,
        merchantUrl: endpoint,
        merchantProfile: doc,
        supportsSteelyardMode: merchant.supports("checkout:steelyard"),
        delegatePaymentUrl: config.delegatePaymentUrl,
        port: opts.port,
        idempotencyKey: opts.idempotencyKey,
        clock: opts.clock,
        onTotalsKnown: opts.onTotalsKnown
      });
    }
  };
  return merchant;
}

function readMcpCommerceVersion(client: Client): string | undefined {
  const capabilities = client.getServerCapabilities() as
    | { extensions?: Record<string, { commerce?: { read?: { version?: string } } }> }
    | undefined;
  return capabilities?.extensions?.["steelyard/commerce"]?.commerce?.read?.version;
}

export function isCompatibleReadVersion(serverVersion: string): boolean {
  const client = parseReadVersion(COMMERCE_READ_VERSION);
  const server = parseReadVersion(serverVersion);
  if (!client || !server) return false;
  return client.major === 0
    ? server.major === 0 && server.minor === client.minor
    : server.major === client.major;
}

function parseReadVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown | SteelyardError> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return fail(response.status === 404 ? "not_found" : "protocol_mismatch", `HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    return isNetworkFailure(error)
      ? fail("network_error", (error as Error).message)
      : fail("protocol_mismatch", (error as Error).message);
  }
}

async function mapCall<T>(
  fn: () => Promise<T | SteelyardError> | T | SteelyardError,
  fallback: ErrorCode = "internal_error"
): Promise<T | SteelyardError> {
  try {
    const result = await fn();
    return isError(result) ? result : result;
  } catch (error) {
    return fail(fallback, (error as Error).message);
  }
}

function parseOffers(text: string): Offer[] {
  return JSON.parse(text) as Offer[];
}

function parseOffer(text: string): Offer {
  return JSON.parse(text) as Offer;
}

function acpOffersFromFeed(feed: unknown, url: URL): Offer[] {
  if (!isAcpFeed(feed)) throw new Error("Invalid ACP feed.");
  return feed.products.map((product) => acpProductToOffer(product, url));
}

function acpProductToOffer(product: AcpProduct, url: URL): Offer {
  const variant = product.variants[0]!;
  return {
    id: product.id,
    title: product.title ?? variant.title,
    description: product.description?.plain ?? variant.description?.plain,
    images: (product.media ?? variant.media ?? []).map((media) => media.url),
    url: product.url ?? variant.url,
    kind: "product",
    categories: (variant.categories ?? []).map((category) => category.value),
    attributes: {},
    availability: variant.availability?.status ?? "unknown",
    pricing: variant.price ? [{ kind: "one_time", amount: variant.price.amount, currency: variant.price.currency }] : []
  };
}

function acpPoliciesFromFeed(feed: unknown): Policies {
  if (!isAcpFeed(feed)) return [];
  const links = feed.products[0]?.variants[0]?.seller?.links ?? [];
  return links.map((link): Policy => ({
    type: policyTypeFromLink(link.type),
    url: link.url,
    summary: link.title
  }));
}

function merchantIdentityFromAcp(feed: unknown, url: URL) {
  const name = isAcpFeed(feed) ? feed.products[0]?.variants[0]?.seller?.name : undefined;
  return { name: name ?? url.host };
}

function ucpProductsToOffers(products: unknown[]): Offer[] {
  return products.map(ucpProductToOffer);
}

function ucpProductToOffer(product: unknown): Offer {
  const item = product as UcpProduct;
  const variant = item.variants[0];
  if (!variant) throw new Error(`UCP product has no variants: ${item.id}`);
  return {
    id: item.id,
    title: item.title,
    description: item.description?.plain ?? variant.description?.plain,
    images: (item.media ?? variant.media ?? []).map((media) => media.url),
    url: item.url ?? variant.url,
    kind: "product",
    categories: (item.categories ?? variant.categories ?? []).map((category) => category.value),
    attributes: {},
    availability: variant.availability?.status ?? "unknown",
    pricing: variant.price ? [{ kind: "one_time", amount: variant.price.amount, currency: variant.price.currency }] : []
  };
}

function filterOffers(offers: Offer[], query: string): Offer[] {
  const q = query.trim().toLowerCase();
  return q
    ? offers.filter((offer) => `${offer.id} ${offer.title} ${offer.description ?? ""} ${offer.categories.join(" ")}`.toLowerCase().includes(q))
    : offers;
}

function findOffer(offers: Offer[], id: string): Offer | SteelyardError {
  const offer = offers.find((item) => item.id === id);
  return offer ?? fail("not_found", `Offer not found: ${id}`);
}

function restEndpoint(doc: UcpDiscovery): string | undefined {
  return doc.ucp.services[UCP_SHOPPING_SERVICE]?.find((service) => service.transport === "rest")?.endpoint;
}

function acpMerchantId(feed: unknown, url: URL): string {
  const merchant = objectRecord(objectRecord(feed).merchant);
  const domain = merchant.domain;
  const id = merchant.id;
  return typeof domain === "string" && domain ? domain : typeof id === "string" && id ? id : url.host;
}

function acpSupportsService(feed: unknown, service: string): boolean {
  const services = objectRecord(objectRecord(feed).capabilities).services;
  return Array.isArray(services) && services.includes(service);
}

function acpCheckoutBaseUrl(url: URL): URL {
  const checkoutUrl = new URL(url);
  checkoutUrl.search = "";
  checkoutUrl.hash = "";
  if (checkoutUrl.pathname.endsWith("/feed")) {
    checkoutUrl.pathname = checkoutUrl.pathname.slice(0, -"/feed".length) || "/";
  } else if (checkoutUrl.pathname.endsWith("/.well-known/acp.json")) {
    checkoutUrl.pathname = "/acp";
  }
  return checkoutUrl;
}

function ucpHasCapability(doc: UcpDiscovery, domain: string, id: string): boolean {
  const bucket = doc.ucp.capabilities?.[domain];
  return Array.isArray(bucket) && bucket.some((entry) => objectRecord(entry).id === id);
}

function ucpHasLegacyCapability(doc: UcpDiscovery, key: string): boolean {
  return Array.isArray(doc.ucp.capabilities?.[key]);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function policyTypeFromLink(type: string): Policy["type"] {
  if (type.startsWith("shipping")) return "shipping";
  if (type.startsWith("returns")) return "returns";
  if (type.startsWith("refunds")) return "refunds";
  if (type.startsWith("terms")) return "terms";
  if (type.startsWith("privacy")) return "privacy";
  return "other";
}

function toolText(result: unknown): string {
  const text = (result as { content: { text: string }[] }).content[0]?.text;
  if (typeof text !== "string") throw new Error("MCP tool did not return text content.");
  return text;
}

function resourceText(result: unknown): string {
  const text = (result as { contents: { text?: string }[] }).contents[0]?.text;
  if (typeof text !== "string") throw new Error("MCP resource did not return text content.");
  return text;
}

function isAcpFeed(value: unknown): value is AcpFeed {
  return !!value && typeof value === "object" && Array.isArray((value as { products?: unknown }).products);
}

function isUcpDiscovery(value: unknown): value is UcpDiscovery {
  const doc = value as UcpDiscovery;
  return !!doc?.ucp?.services?.[UCP_SHOPPING_SERVICE] && (
    ucpHasCapability(doc, UCP_SHOPPING_DOMAIN, UCP_CATALOG_SEARCH_CAPABILITY_ID)
    || ucpHasLegacyCapability(doc, UCP_CATALOG_SEARCH_CAPABILITY)
  );
}

function isError(value: unknown): value is SteelyardError {
  return !!value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string";
}

function isNetworkFailure(error: unknown): boolean {
  const message = (error as Error).message ?? "";
  return /fetch failed|ECONN|ENOTFOUND|ECONNREFUSED|network/i.test(message);
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    return;
  }
}

function fail(error: ErrorCode, error_detail?: string): SteelyardError {
  return error_detail ? { error, error_detail } : { error };
}

interface AcpFeed {
  products: AcpProduct[];
  capabilities?: { services?: string[] };
  merchant?: { id?: string; domain?: string };
}

interface AcpProduct {
  id: string;
  title?: string;
  description?: { plain?: string };
  url?: string;
  media?: { url: string }[];
  variants: {
    id: string;
    title: string;
    description?: { plain?: string };
    url?: string;
    price?: { amount: number; currency: string };
    availability?: { status?: Offer["availability"] };
    categories?: { value: string }[];
    media?: { url: string }[];
    seller?: { name?: string; links?: { type: string; title?: string; url: string }[] };
  }[];
}

interface UcpDiscovery {
  ucp: {
    services: Record<string, { transport?: string; endpoint?: string }[]>;
    capabilities?: Record<string, unknown>;
    payment_handlers?: Record<string, unknown>;
  };
  merchant?: { name?: string; domain?: string };
}

interface UcpProduct {
  id: string;
  title: string;
  description?: { plain?: string };
  url?: string;
  categories?: { value: string }[];
  media?: { url: string }[];
  variants: {
    id: string;
    title: string;
    description?: { plain?: string };
    url?: string;
    price?: { amount: number; currency: string };
    availability?: { status?: Offer["availability"] };
    categories?: { value: string }[];
    media?: { url: string }[];
  }[];
}
