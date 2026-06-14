// Copyright (c) Steelyard contributors. MIT License.
import { uuidv7 } from "uuidv7";

export type IdempotencyKey = string;

export function newIdempotencyKey(): IdempotencyKey {
  return uuidv7();
}
