import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  COMMERCE_READ_VERSION,
  defineCommerce,
  type ErrorCode,
  type Manifest,
  type Offer,
  type Policies,
  type Policy
} from "@steelyard/core";

export type Protocol = "mcp" | "acp" | "ucp";

export interface SteelyardError {
  error: ErrorCode;
  error_detail?: string;
}

export interface Merchant {
  protocol: Protocol;
  search(query: string): Promise<Offer[] | SteelyardError>;
  getOffer(id: string): Promise<Offer | SteelyardError>;
  getManifest(): Promise<Manifest | SteelyardError>;
  getPolicies(): Promise<Policies | SteelyardError>;
}

type DetectionResult = Merchant | SteelyardError | undefined;

export const Steelyard = {
  connect
};

export async function connect(url: string): Promise<Merchant | SteelyardError> {
  const parsed = parseUrl(url);
  if ("error" in parsed) return parsed;

  const mcp = await detectMcp(parsed);
  if (mcp) return mcp;

  const acp = await detectAcp(parsed);
  if (acp) return acp;

  const ucp = await detectUcp(parsed);
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

async function detectAcp(url: URL): Promise<DetectionResult> {
  const feed = await fetchJson(url);
  if (isError(feed)) return feed.error === "network_error" ? feed : undefined;
  if (!isAcpFeed(feed)) return undefined;
  return acpMerchant(url, feed);
}

async function detectUcp(url: URL): Promise<DetectionResult> {
  const discoveryUrl = url.pathname.endsWith("/.well-known/ucp")
    ? url
    : new URL("/.well-known/ucp", url);
  const doc = await fetchJson(discoveryUrl);
  if (isError(doc)) return doc.error === "network_error" ? doc : undefined;
  if (!isUcpDiscovery(doc)) return undefined;
  return ucpMerchant(doc, discoveryUrl);
}

function mcpMerchant(client: Client, url: URL): Merchant {
  return {
    protocol: "mcp",
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
    }
  };
}

function acpMerchant(url: URL, initialFeed: unknown): Merchant {
  const loadOffers = async () => acpOffersFromFeed(isAcpFeed(initialFeed) ? initialFeed : await fetchJson(url), url);
  const loadPolicies = async () => acpPoliciesFromFeed(isAcpFeed(initialFeed) ? initialFeed : await fetchJson(url));
  return {
    protocol: "acp",
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
    }
  };
}

function ucpMerchant(doc: UcpDiscovery, discoveryUrl: URL): Merchant {
  const endpoint = restEndpoint(doc) ?? new URL("/api", discoveryUrl).toString();
  const identity = { name: doc.merchant?.name ?? discoveryUrl.host, domain: doc.merchant?.domain ?? discoveryUrl.host };
  const post = (path: string, body: unknown) => fetchJson(new URL(`${endpoint.replace(/\/$/, "")}${path}`), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });

  return {
    protocol: "ucp",
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
    async getManifest() {
      return mapCall(async () => {
        const response = await post("/catalog/search", {});
        if (isError(response)) return response;
        return defineCommerce({ identity, offers: ucpProductsToOffers((response as { products?: unknown[] }).products ?? []) });
      });
    },
    async getPolicies() {
      return [];
    }
  };
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
  return { name: name ?? url.host, domain: url.host };
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
  return doc.ucp.services["dev.ucp.shopping"]?.find((service) => service.transport === "rest")?.endpoint;
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
  return !!doc?.ucp?.services?.["dev.ucp.shopping"] && !!doc.ucp.capabilities?.["dev.ucp.shopping.catalog.search"];
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
