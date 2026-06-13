// Copyright (c) Steelyard contributors. MIT License.
export const ERROR_CODES = [
  "not_found",
  "version_mismatch",
  "protocol_mismatch",
  "network_error",
  "internal_error"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
