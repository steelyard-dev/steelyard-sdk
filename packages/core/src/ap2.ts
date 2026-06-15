// Copyright (c) Steelyard contributors. MIT License.
export const UCP_AP2_CAPABILITY = "dev.ucp.shopping.ap2_mandate" as const;

export const AP2_ERROR_CODES = [
  "mandate_required",
  "agent_missing_key",
  "mandate_invalid_signature",
  "mandate_expired",
  "mandate_scope_mismatch",
  "merchant_authorization_invalid",
  "merchant_authorization_missing"
] as const;

export type Ap2ErrorCode = (typeof AP2_ERROR_CODES)[number];

export type DisclosureClaim = "always" | "selective";

export interface DisclosureTree {
  alwaysDisclosed: string[];
  selectivelyDisclosed: string[];
}
