// Copyright (c) Steelyard contributors. MIT License.
//
// Centralized registry of the UCP JSON Schemas this package validates against
// at runtime. Imported by catalog.ts so every catalog response is AJV-validated
// against the same vendored spec the discovery doc advertises.
//
// To add a new schema:
//   1. Add the `import` line below
//   2. Add it to the ALL_SCHEMAS array
//   3. AJV will resolve $refs across the whole set at compile-validator time

import amountSchema from "../spec/2026-04-08/schemas/common/types/amount.json";
import descriptionSchema from "../spec/2026-04-08/schemas/common/types/description.json";
import errorCodeSchema from "../spec/2026-04-08/schemas/common/types/error_code.json";
import infoCodeSchema from "../spec/2026-04-08/schemas/common/types/info_code.json";
import linkSchema from "../spec/2026-04-08/schemas/common/types/link.json";
import mediaSchema from "../spec/2026-04-08/schemas/common/types/media.json";
import messageSchema from "../spec/2026-04-08/schemas/common/types/message.json";
import messageErrorSchema from "../spec/2026-04-08/schemas/common/types/message_error.json";
import messageInfoSchema from "../spec/2026-04-08/schemas/common/types/message_info.json";
import messageWarningSchema from "../spec/2026-04-08/schemas/common/types/message_warning.json";
import paginationSchema from "../spec/2026-04-08/schemas/common/types/pagination.json";
import priceSchema from "../spec/2026-04-08/schemas/common/types/price.json";
import reverseDomainNameSchema from "../spec/2026-04-08/schemas/common/types/reverse_domain_name.json";
import warningCodeSchema from "../spec/2026-04-08/schemas/common/types/warning_code.json";

import attributionSchema from "../spec/2026-04-08/schemas/shopping/types/attribution.json";
import availablePaymentInstrumentSchema from "../spec/2026-04-08/schemas/shopping/types/available_payment_instrument.json";
import categorySchema from "../spec/2026-04-08/schemas/shopping/types/category.json";
import contextSchema from "../spec/2026-04-08/schemas/shopping/types/context.json";
import detailOptionValueSchema from "../spec/2026-04-08/schemas/shopping/types/detail_option_value.json";
import inputCorrelationSchema from "../spec/2026-04-08/schemas/shopping/types/input_correlation.json";
import optionValueSchema from "../spec/2026-04-08/schemas/shopping/types/option_value.json";
import priceFilterSchema from "../spec/2026-04-08/schemas/shopping/types/price_filter.json";
import priceRangeSchema from "../spec/2026-04-08/schemas/shopping/types/price_range.json";
import productSchema from "../spec/2026-04-08/schemas/shopping/types/product.json";
import productOptionSchema from "../spec/2026-04-08/schemas/shopping/types/product_option.json";
import ratingSchema from "../spec/2026-04-08/schemas/shopping/types/rating.json";
import searchFiltersSchema from "../spec/2026-04-08/schemas/shopping/types/search_filters.json";
import selectedOptionSchema from "../spec/2026-04-08/schemas/shopping/types/selected_option.json";
import signalsSchema from "../spec/2026-04-08/schemas/shopping/types/signals.json";
import variantSchema from "../spec/2026-04-08/schemas/shopping/types/variant.json";

import catalogLookupSchema from "../spec/2026-04-08/schemas/shopping/catalog_lookup.json";
import catalogSearchSchema from "../spec/2026-04-08/schemas/shopping/catalog_search.json";

import capabilitySchema from "../spec/2026-04-08/schemas/capability.json";
import paymentHandlerSchema from "../spec/2026-04-08/schemas/payment_handler.json";
import serviceSchema from "../spec/2026-04-08/schemas/service.json";
import ucpSchema from "../spec/2026-04-08/schemas/ucp.json";
import embeddedConfigSchema from "../spec/2026-04-08/schemas/transports/embedded_config.json";

/**
 * Every UCP JSON Schema this package validates against at runtime. Order
 * matters for AJV $ref resolution: leaf types first, composite schemas last.
 */
export const ALL_SCHEMAS = [
  // common leaf types (refd by shopping types)
  amountSchema,
  descriptionSchema,
  errorCodeSchema,
  infoCodeSchema,
  linkSchema,
  mediaSchema,
  paginationSchema,
  priceSchema,
  reverseDomainNameSchema,
  warningCodeSchema,
  // message types (depend on info/error/warning codes)
  messageErrorSchema,
  messageInfoSchema,
  messageWarningSchema,
  messageSchema,
  // transports / payment instruments (refd by ucp.json)
  embeddedConfigSchema,
  availablePaymentInstrumentSchema,
  // shopping leaf types (refd by product/variant)
  attributionSchema,
  categorySchema,
  contextSchema,
  detailOptionValueSchema,
  inputCorrelationSchema,
  optionValueSchema,
  priceFilterSchema,
  priceRangeSchema,
  productOptionSchema,
  ratingSchema,
  searchFiltersSchema,
  selectedOptionSchema,
  signalsSchema,
  // shopping composite types
  variantSchema,
  productSchema,
  // top-level UCP entities (envelope + capability + service)
  ucpSchema,
  serviceSchema,
  capabilitySchema,
  paymentHandlerSchema,
  // catalog requests + responses (the schemas whose `$defs/*_response` we validate)
  catalogSearchSchema,
  catalogLookupSchema
] as const;

export const CATALOG_SEARCH_SCHEMA_ID = "https://ucp.dev/schemas/shopping/catalog_search.json";
export const CATALOG_LOOKUP_SCHEMA_ID = "https://ucp.dev/schemas/shopping/catalog_lookup.json";
