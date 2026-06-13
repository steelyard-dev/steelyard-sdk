// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import type { ZodError } from "zod";
import { COMMERCE_READ_VERSION, ManifestSchema } from "./schemas.js";
import type { Manifest, Offer, ParsedCommerceConfig } from "./schemas.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesFromZod(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.join(".") : "(root)",
    message: issue.message
  }));
}

export function duplicateOfferIssues(offers: Offer[]): ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  offers.forEach((offer, index) => {
    if (seen.has(offer.id)) {
      issues.push({
        path: `offers.${index}.id`,
        message: `Duplicate offer id: ${offer.id}`
      });
    }
    seen.add(offer.id);
  });
  return issues;
}

export function manifestFromConfig(config: ParsedCommerceConfig): Manifest {
  return ManifestSchema.parse({
    schemaVersion: COMMERCE_READ_VERSION,
    identity: config.identity,
    catalog: {
      offers: [...config.offers].sort((left, right) => left.id.localeCompare(right.id))
    },
    policies: config.policies
  });
}
