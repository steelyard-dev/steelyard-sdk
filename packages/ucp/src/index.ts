export {
  getProduct,
  lookupCatalog,
  searchCatalog
} from "./catalog.js";
export type {
  UcpCatalogResponse,
  UcpPrice,
  UcpProduct,
  UcpProductResponse,
  UcpVariant
} from "./catalog.js";
export {
  UCP_API_PATH,
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_SHOPPING_SERVICE,
  UCP_VERSION,
  UCP_WELL_KNOWN_PATH,
  assertValidUcpDiscovery,
  buildUcpDiscovery,
  validateUcpDiscovery
} from "./discovery.js";
export type { UcpDiscoveryDoc, UcpEntity, UcpValidationResult } from "./discovery.js";
export { createUcpHandler } from "./http.js";
export type { UcpHandlerOptions } from "./http.js";
