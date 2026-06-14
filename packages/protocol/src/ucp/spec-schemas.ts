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

import amountSchema from "../../spec/ucp/2026-04-17/schemas/common/types/amount.json";
import descriptionSchema from "../../spec/ucp/2026-04-17/schemas/common/types/description.json";
import errorCodeSchema from "../../spec/ucp/2026-04-17/schemas/common/types/error_code.json";
import infoCodeSchema from "../../spec/ucp/2026-04-17/schemas/common/types/info_code.json";
import linkSchema from "../../spec/ucp/2026-04-17/schemas/common/types/link.json";
import mediaSchema from "../../spec/ucp/2026-04-17/schemas/common/types/media.json";
import messageSchema from "../../spec/ucp/2026-04-17/schemas/common/types/message.json";
import messageErrorSchema from "../../spec/ucp/2026-04-17/schemas/common/types/message_error.json";
import messageInfoSchema from "../../spec/ucp/2026-04-17/schemas/common/types/message_info.json";
import messageWarningSchema from "../../spec/ucp/2026-04-17/schemas/common/types/message_warning.json";
import paginationSchema from "../../spec/ucp/2026-04-17/schemas/common/types/pagination.json";
import priceSchema from "../../spec/ucp/2026-04-17/schemas/common/types/price.json";
import reverseDomainNameSchema from "../../spec/ucp/2026-04-17/schemas/common/types/reverse_domain_name.json";
import postalAddressSchema from "../../spec/ucp/2026-04-17/schemas/common/types/postal_address.json";
import signedAmountSchema from "../../spec/ucp/2026-04-17/schemas/common/types/signed_amount.json";
import warningCodeSchema from "../../spec/ucp/2026-04-17/schemas/common/types/warning_code.json";

import attributionSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/attribution.json";
import availablePaymentInstrumentSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/available_payment_instrument.json";
import buyerSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/buyer.json";
import categorySchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/category.json";
import contextSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/context.json";
import detailOptionValueSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/detail_option_value.json";
import inputCorrelationSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/input_correlation.json";
import itemSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/item.json";
import lineItemSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/line_item.json";
import optionValueSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/option_value.json";
import orderConfirmationSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/order_confirmation.json";
import paymentCredentialSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/payment_credential.json";
import paymentInstrumentSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/payment_instrument.json";
import priceFilterSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/price_filter.json";
import priceRangeSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/price_range.json";
import productSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/product.json";
import productOptionSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/product_option.json";
import ratingSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/rating.json";
import searchFiltersSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/search_filters.json";
import selectedOptionSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/selected_option.json";
import signalsSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/signals.json";
import totalSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/total.json";
import totalsSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/totals.json";
import variantSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/variant.json";

import catalogLookupSchema from "../../spec/ucp/2026-04-17/schemas/shopping/catalog_lookup.json";
import catalogSearchSchema from "../../spec/ucp/2026-04-17/schemas/shopping/catalog_search.json";
import cartSchema from "../../spec/ucp/2026-04-17/schemas/shopping/cart.json";
import checkoutSchema from "../../spec/ucp/2026-04-17/schemas/shopping/checkout.json";
import paymentSchema from "../../spec/ucp/2026-04-17/schemas/shopping/payment.json";

import capabilitySchema from "../../spec/ucp/2026-04-17/schemas/capability.json";
import paymentHandlerSchema from "../../spec/ucp/2026-04-17/schemas/payment_handler.json";
import serviceSchema from "../../spec/ucp/2026-04-17/schemas/service.json";
import ucpSchema from "../../spec/ucp/2026-04-17/schemas/ucp.json";
import embeddedConfigSchema from "../../spec/ucp/2026-04-17/schemas/transports/embedded_config.json";

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
  postalAddressSchema,
  priceSchema,
  reverseDomainNameSchema,
  signedAmountSchema,
  warningCodeSchema,
  // message types (depend on info/error/warning codes)
  messageErrorSchema,
  messageInfoSchema,
  messageWarningSchema,
  messageSchema,
  // transports / payment instruments (refd by ucp.json)
  embeddedConfigSchema,
  availablePaymentInstrumentSchema,
  paymentCredentialSchema,
  paymentInstrumentSchema,
  // shopping leaf types (refd by product/variant)
  attributionSchema,
  buyerSchema,
  categorySchema,
  contextSchema,
  detailOptionValueSchema,
  inputCorrelationSchema,
  itemSchema,
  optionValueSchema,
  orderConfirmationSchema,
  priceFilterSchema,
  priceRangeSchema,
  productOptionSchema,
  ratingSchema,
  searchFiltersSchema,
  selectedOptionSchema,
  signalsSchema,
  totalSchema,
  totalsSchema,
  // shopping composite types
  lineItemSchema,
  variantSchema,
  productSchema,
  // top-level UCP entities (envelope + capability + service)
  ucpSchema,
  serviceSchema,
  capabilitySchema,
  paymentHandlerSchema,
  paymentSchema,
  checkoutSchema,
  cartSchema,
  // catalog requests + responses (the schemas whose `$defs/*_response` we validate)
  catalogSearchSchema,
  catalogLookupSchema
] as const;

export const CATALOG_SEARCH_SCHEMA_ID = "https://ucp.dev/schemas/shopping/catalog_search.json";
export const CATALOG_LOOKUP_SCHEMA_ID = "https://ucp.dev/schemas/shopping/catalog_lookup.json";
export const CHECKOUT_SCHEMA_ID = "https://ucp.dev/schemas/shopping/checkout.json";
export const CART_SCHEMA_ID = "https://ucp.dev/schemas/shopping/cart.json";
export const PAYMENT_INSTRUMENT_SCHEMA_ID = "https://ucp.dev/schemas/shopping/types/payment_instrument.json";
