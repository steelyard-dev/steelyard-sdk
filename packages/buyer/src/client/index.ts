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
  assertValidAcpDiscovery,
  type AcpDiscoveryResponse,
  type AcpFeed,
  type AcpProduct
} from "@steelyard/protocol/acp";
import {
  STEELYARD_CHECKOUT_MANDATE_V01,
  UCP_AP2_CAPABILITY,
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_CHECKOUT_CAPABILITY,
  UCP_SHOPPING_SERVICE,
  UCP_WELL_KNOWN_PATH,
  UcpProfileCache,
  UcpProfileFetchError,
  resolveSigningKey,
  type UcpProfileDoc
} from "@steelyard/protocol/ucp";
import { acpDriver, type AcpAuthOptions } from "./acp.js";
import { handlerSupportsInstrument } from "./driver-common.js";
import { ucpDriver, type UcpAp2MandateOptions, type UcpAuthOptions } from "./ucp.js";

export { createUcpBuyerProfile, createUcpBuyerProfileHandler } from "./profile.js";
export type { UcpBuyerProfileOptions } from "./profile.js";
export { AcpNoCompatibleHandler, AcpPaymentIssuerMissing, AcpUnsupportedPaymentIssuer, verifyAcpWebhook } from "./acp.js";
export type { AcpAuthOptions, AcpWebhookVerifyArgs } from "./acp.js";
export { Ap2MerchantAuthorizationInvalid, Ap2SessionInconsistent, UcpAuthMissing, UcpResponseSignatureInvalid } from "./ucp.js";
export type { UcpAp2MandateOptions, UcpAuthOptions, UcpAuthPreference, UcpHmsSigningOptions } from "./ucp.js";

export type Protocol = "mcp" | "acp" | "ucp";
export type MerchantCapability = "read" | "checkout" | "checkout:steelyard" | "checkout:ap2" | "discounts";

export interface MerchantPaymentHandler {
  namespace: string;
  id: string;
  available_instruments?: Record<string, unknown>[];
}

export interface SteelyardError {
  error: ErrorCode;
  error_detail?: string;
}

export interface ConnectOptions {
  allowPrivateNetwork?: boolean;
  delegatePaymentUrl?: string;
  ucpProfileCache?: UcpProfileCache;
  ucpAuth?: UcpAuthOptions;
  acpAuth?: AcpAuthOptions;
  ap2?: UcpAp2MandateOptions;
}

export interface PurchaseOpts {
  port: WalletDriverPort;
  approval?: ApprovalProof;
  resume?: ApprovalResume;
  idempotencyKey?: string;
  reservation_id?: string;
  clock?: () => Date;
  onTotalsKnown?: (finalTotal: number, currency: string) => Promise<void> | void;
}

export interface Merchant {
  id: string;
  protocol: Protocol;
  url: string;
  paymentHandlers?: MerchantPaymentHandler[];
  supports(capability: MerchantCapability): boolean;
  search(query: string): Promise<Offer[] | SteelyardError>;
  lookup(id: string): Promise<Offer | SteelyardError>;
  getOffer(id: string): Promise<Offer | SteelyardError>;
  getManifest(): Promise<Manifest | SteelyardError>;
  getPolicies(): Promise<Policies | SteelyardError>;
  purchase(intent: PurchaseIntent, opts: PurchaseOpts): Promise<Receipt>;
  cancel?(sessionId: string, opts?: { idempotencyKey?: string }): Promise<unknown | SteelyardError>;
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

export class BuyerHmsProfileMissing extends Error {
  constructor() {
    super("UCP HMS signing requires ucpAuth.signing.profileUrl");
    this.name = "BuyerHmsProfileMissing";
  }
}

export class BuyerAp2ProfileMissing extends Error {
  constructor() {
    super("UCP AP2 requires ucpAuth.signing.profileUrl so the buyer profile can advertise AP2");
    this.name = "BuyerAp2ProfileMissing";
  }
}

export class NoCompatiblePaymentHandlerError extends Error {
  readonly protocol: Protocol;
  readonly instrumentType?: string;

  constructor(opts: { protocol: Protocol; instrumentType?: string }) {
    super(
      opts.instrumentType
        ? `${opts.protocol.toUpperCase()} checkout has no compatible payment handler for ${opts.instrumentType}`
        : `${opts.protocol.toUpperCase()} checkout requires a compatible payment issuer`
    );
    this.name = "NoCompatiblePaymentHandlerError";
    this.protocol = opts.protocol;
    this.instrumentType = opts.instrumentType;
  }
}

type DetectionResult = Merchant | SteelyardError | undefined;

export const UCP_LEGACY_CAPABILITY_ALIASES: Record<string, { bucket: string; id: string }> = {
  [UCP_CHECKOUT_CAPABILITY]: { bucket: "dev.ucp.shopping", id: "checkout" },
  [UCP_CATALOG_SEARCH_CAPABILITY]: { bucket: "dev.ucp.shopping", id: "catalog.search" },
  [UCP_CATALOG_LOOKUP_CAPABILITY]: { bucket: "dev.ucp.shopping", id: "catalog.lookup" },
  [STEELYARD_CHECKOUT_MANDATE_V01]: { bucket: "net.steelyard", id: "checkout_mandate.v0.1" }
};

export const Steelyard = {
  connect
};

const defaultUcpProfileCache = new UcpProfileCache();
const ACP_WELL_KNOWN_PATH = "/.well-known/acp.json";

export async function connect(url: string, opts: ConnectOptions = {}): Promise<Merchant | SteelyardError> {
  assertConnectUcpAuth(opts);
  const parsed = parseUrl(url);
  if ("error" in parsed) return parsed;

  const mcp = await detectMcp(parsed);
  if (mcp) return mcp;

  if (!parsed.pathname.endsWith(UCP_WELL_KNOWN_PATH)) {
    const acp = await detectAcp(parsed, opts);
    if (acp) return acp;
  }

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
  const explicitDiscoveryUrl = url.pathname.endsWith(ACP_WELL_KNOWN_PATH);
  const discoveryUrl = explicitDiscoveryUrl ? url : new URL(ACP_WELL_KNOWN_PATH, url);
  const discovery = await fetchJson(discoveryUrl);
  if (isError(discovery)) {
    if (discovery.error === "network_error") return discovery;
    if (explicitDiscoveryUrl) return undefined;
  } else if (isAcpDiscovery(discovery)) {
    return acpMerchant(discoveryUrl, discovery, opts);
  } else if (explicitDiscoveryUrl) {
    return undefined;
  }

  const feed = await fetchJson(url);
  if (isError(feed)) return feed.error === "network_error" ? feed : undefined;
  if (!isAcpFeed(feed)) return undefined;
  return acpMerchant(url, feed, opts);
}

async function detectUcp(url: URL, opts: ConnectOptions): Promise<DetectionResult> {
  const explicitDiscoveryUrl = url.pathname.endsWith(UCP_WELL_KNOWN_PATH);
  const discoveryUrl = explicitDiscoveryUrl
    ? url
    : new URL(UCP_WELL_KNOWN_PATH, url);
  let doc: unknown;
  try {
    doc = await (opts.ucpProfileCache ?? defaultUcpProfileCache).get(discoveryUrl, {
      allowPrivateNetwork: opts.allowPrivateNetwork
    });
  } catch (error) {
    return ucpProfileFetchFailure(error, explicitDiscoveryUrl);
  }
  if (!isUcpDiscovery(doc)) return undefined;
  let buyerProfile: UcpProfileDoc | undefined;
  try {
    buyerProfile = await fetchBuyerAp2Profile(opts);
  } catch (error) {
    return ucpProfileFetchFailure(error, true);
  }
  return ucpMerchant(doc, discoveryUrl, opts, buyerProfile);
}

function mcpMerchant(client: Client, url: URL): Merchant {
  const merchant: Merchant = {
    id: url.host,
    protocol: "mcp",
    url: url.toString(),
    paymentHandlers: [],
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
  const discovery = isAcpDiscovery(initialFeed) ? initialFeed : undefined;
  const checkoutUrl = discovery?.api_base_url ?? acpCheckoutBaseUrl(url).toString();
  const feedUrl = discovery ? new URL(`${checkoutUrl.replace(/\/$/, "")}/feed`) : url;
  const loadFeed = async () => isAcpFeed(initialFeed) ? initialFeed : await fetchJson(feedUrl);
  const loadOffers = async () => acpOffersFromFeed(await loadFeed(), feedUrl);
  const loadPolicies = async () => acpPoliciesFromFeed(await loadFeed());
  const checkoutSupported = acpSupportsService(initialFeed, "checkout");
  const merchant: Merchant = {
    id: acpMerchantId(initialFeed, url),
    protocol: "acp",
    url: checkoutUrl,
    paymentHandlers: [],
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
      return mapCall(async () => {
        const feed = await loadFeed();
        return defineCommerce({
          identity: merchantIdentityFromAcp(feed, feedUrl),
          offers: acpOffersFromFeed(feed, feedUrl),
          policies: acpPoliciesFromFeed(feed)
        });
      });
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
        acpAuth: config.acpAuth,
        port: opts.port,
        idempotencyKey: opts.idempotencyKey,
        clock: opts.clock,
        onTotalsKnown: opts.onTotalsKnown
      });
    },
    async cancel(sessionId, opts = {}) {
      return mapCall(() =>
        acpDriver.cancel(sessionId, {
          merchantUrl: checkoutUrl,
          acpAuth: config.acpAuth,
          idempotencyKey: opts.idempotencyKey
        })
      );
    }
  };
  return merchant;
}

function ucpMerchant(
  doc: UcpDiscovery,
  discoveryUrl: URL,
  config: ConnectOptions,
  buyerProfile?: UcpProfileDoc
): Merchant {
  const endpoint = restEndpoint(doc) ?? new URL("/api", discoveryUrl).toString();
  const identity = { name: doc.merchant?.name ?? discoveryUrl.host, domain: doc.merchant?.domain };
  const id = canonicalMerchantAudience({
    id: doc.merchant?.domain ?? discoveryUrl.host,
    protocol: "ucp",
    discoveryUrl: discoveryUrl.toString()
  });
  const paymentHandlers = flattenedPaymentHandlers(doc.ucp.payment_handlers);
  const checkoutSupported = ucpHasCapability(doc, UCP_CHECKOUT_CAPABILITY);
  const ap2Locked = checkoutSupported && buyerSupportsAp2(config, buyerProfile) && ucpHasCapability(doc, UCP_AP2_CAPABILITY);
  const post = (path: string, body: unknown) => fetchJson(new URL(`${endpoint.replace(/\/$/, "")}${path}`), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });

  const merchant: Merchant = {
    id,
    protocol: "ucp",
    url: endpoint,
    paymentHandlers,
    supports(capability) {
      if (capability === "read") return true;
      if (capability === "checkout") return checkoutSupported;
      if (capability === "checkout:steelyard") {
        return checkoutSupported && !ap2Locked && ucpHasCapability(doc, STEELYARD_CHECKOUT_MANDATE_V01);
      }
      if (capability === "checkout:ap2") {
        return ap2Locked;
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
        const offers = ucpProductsToOffers((response as { products?: unknown[] }).products ?? []);
        return defineCommerce({ identity: { ...identity, currencies: currenciesFromOffers(offers) }, offers });
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
      assertCompatiblePaymentHandler("ucp", paymentHandlers, config, opts.port);
      return ucpDriver.purchase(intent, {
        merchantId: merchant.id,
        merchantUrl: endpoint,
        merchantProfile: doc,
        supportsSteelyardMode: !ap2Locked && merchant.supports("checkout:steelyard"),
        ap2Locked,
        ap2: ap2Locked ? config.ap2 : undefined,
        delegatePaymentUrl: config.delegatePaymentUrl,
        ucpAuth: config.ucpAuth,
        port: opts.port,
        idempotencyKey: opts.idempotencyKey,
        clock: opts.clock,
        onTotalsKnown: opts.onTotalsKnown
      });
    }
  };
  return merchant;
}

function assertConnectUcpAuth(opts: ConnectOptions): void {
  const auth = opts.ucpAuth;
  if (opts.ap2?.enabled && !auth?.signing?.profileUrl) {
    throw new BuyerAp2ProfileMissing();
  }
  if (!auth) return;
  const preferred = auth.preferred ?? "hms";
  if (preferred !== "hms") return;
  if (auth.signing && (typeof auth.signing.profileUrl !== "string" || !auth.signing.profileUrl)) {
    throw new BuyerHmsProfileMissing();
  }
}

async function fetchBuyerAp2Profile(opts: ConnectOptions): Promise<UcpProfileDoc | undefined> {
  if (opts.ap2?.enabled !== true) return undefined;
  const profileUrl = opts.ucpAuth?.signing?.profileUrl;
  if (!profileUrl) return undefined;
  return await (opts.ucpProfileCache ?? defaultUcpProfileCache).get(profileUrl, {
    allowPrivateNetwork: opts.allowPrivateNetwork
  });
}

function buyerSupportsAp2(opts: ConnectOptions, profile: UcpProfileDoc | undefined): boolean {
  if (opts.ap2?.enabled !== true || !profile) return false;
  if (!ucpHasCapability(profile, UCP_AP2_CAPABILITY)) return false;
  const kid = opts.ucpAuth?.signing?.kid;
  return typeof kid === "string" && !!resolveSigningKey(profile, kid);
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
    /* c8 ignore next -- current read capability is pre-1.0; this branch activates after a 1.0 read capability. */
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
    availability: acpAvailabilityStatus(variant.availability?.status),
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
  const acpFeed = isAcpFeed(feed) ? feed : undefined;
  const merchant = objectRecord(objectRecord(feed).merchant);
  const domain = typeof merchant.domain === "string" && merchant.domain ? merchant.domain : undefined;
  const name = acpFeed?.products[0]?.variants[0]?.seller?.name;
  const currencies = [
    ...new Set(
      (acpFeed?.products ?? [])
        .flatMap((product) => product.variants)
        .map((variant) => variant.price?.currency)
        .filter((currency): currency is string => typeof currency === "string" && !!currency)
    )
  ];
  return {
    name: name ?? domain ?? url.host,
    ...(domain ? { domain } : {}),
    ...(currencies.length ? { currencies } : {})
  };
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

function currenciesFromOffers(offers: Offer[]): string[] {
  return [
    ...new Set(
      offers
        .flatMap((offer) => offer.pricing)
        .map((price) => ("currency" in price ? price.currency : undefined))
        .filter((currency): currency is string => typeof currency === "string" && !!currency)
    )
  ];
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
  if (isAcpDiscovery(feed)) return (feed.capabilities.services as readonly string[]).includes(service);
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

function ucpHasCapability(doc: { ucp: { capabilities?: Record<string, unknown> } }, capabilityKey: string): boolean {
  const canonical = doc.ucp.capabilities?.[capabilityKey];
  if (Array.isArray(canonical) && canonical.length > 0) return true;

  const legacy = UCP_LEGACY_CAPABILITY_ALIASES[capabilityKey];
  if (!legacy) return false;
  const bucket = doc.ucp.capabilities?.[legacy.bucket];
  return Array.isArray(bucket) && bucket.some((entry) => objectRecord(entry).id === legacy.id);
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

function acpAvailabilityStatus(value: unknown): Offer["availability"] {
  return value === "in_stock" || value === "out_of_stock" || value === "preorder" ? value : "unknown";
}

function isAcpDiscovery(value: unknown): value is AcpDiscoveryResponse {
  try {
    assertValidAcpDiscovery(value);
    return true;
  } catch {
    return false;
  }
}

function isUcpDiscovery(value: unknown): value is UcpDiscovery {
  const doc = value as UcpDiscovery;
  return !!doc?.ucp?.services?.[UCP_SHOPPING_SERVICE] && (
    ucpHasCapability(doc, UCP_CATALOG_SEARCH_CAPABILITY)
    || ucpHasCapability(doc, UCP_CHECKOUT_CAPABILITY)
  );
}

function flattenedPaymentHandlers(catalog: Record<string, unknown> | undefined): MerchantPaymentHandler[] {
  return Object.entries(catalog ?? {}).flatMap(([namespace, value]) =>
    Array.isArray(value)
      ? value.map((handler) => {
          const record = objectRecord(handler);
          return {
            namespace,
            id: String(record.id ?? ""),
            available_instruments: Array.isArray(record.available_instruments)
              ? record.available_instruments.map(objectRecord)
              : undefined
          };
        }).filter((handler) => handler.id)
      : []
  );
}

function assertCompatiblePaymentHandler(
  protocol: Protocol,
  handlers: MerchantPaymentHandler[],
  config: ConnectOptions,
  port: WalletDriverPort
): void {
  if (!handlers.length || config.delegatePaymentUrl) return;
  const issuer = port.paymentIssuer;
  if (!issuer || !handlers.some((handler) => handlerSupportsInstrument(handler, issuer.instrumentType))) {
    throw new NoCompatiblePaymentHandlerError({ protocol, instrumentType: issuer?.instrumentType });
  }
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
  /* c8 ignore next -- cleanup is best-effort when an MCP client is already failed or closed. */
  } catch {
    return;
  }
}

function fail(error: ErrorCode, error_detail?: string): SteelyardError {
  return error_detail ? { error, error_detail } : { error };
}

function ucpProfileFetchFailure(error: unknown, explicitDiscoveryUrl: boolean): DetectionResult {
  if (!(error instanceof UcpProfileFetchError)) return fail("protocol_mismatch", (error as Error).message);
  if (!explicitDiscoveryUrl && (error.code === "Ucp.ProfileHttp" || error.code === "Ucp.ProfileInvalid")) {
    return undefined;
  }
  if (error.code === "Ucp.ProfileTimeout" || error.code === "Ucp.ProfileUnreachable") {
    return fail("network_error", error.message);
  }
  return fail("protocol_mismatch", error.message);
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
