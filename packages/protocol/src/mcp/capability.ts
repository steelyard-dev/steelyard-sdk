// Copyright (c) Steelyard contributors. MIT License.
import { COMMERCE_READ_VERSION } from "@steelyard-dev/core";

export const COMMERCE_CAPABILITY = {
  read: { version: COMMERCE_READ_VERSION }
} as const;

export const COMMERCE_EXTENSION_KEY = "steelyard/commerce" as const;
