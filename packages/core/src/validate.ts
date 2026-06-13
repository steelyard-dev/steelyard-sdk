// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { CommerceConfigSchema } from "./schemas.js";
import { duplicateOfferIssues, issuesFromZod, manifestFromConfig } from "./internal.js";
import type { Manifest } from "./schemas.js";
import type { ValidationIssue } from "./internal.js";

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  manifest?: Manifest;
}

export function validate(config: unknown): ValidationResult {
  const parsed = CommerceConfigSchema.safeParse(config);
  if (!parsed.success) {
    return { ok: false, issues: issuesFromZod(parsed.error) };
  }

  const duplicateIssues = duplicateOfferIssues(parsed.data.offers);
  if (duplicateIssues.length) {
    return { ok: false, issues: duplicateIssues };
  }

  return { ok: true, issues: [], manifest: manifestFromConfig(parsed.data) };
}
