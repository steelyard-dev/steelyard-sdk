// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { CommerceConfigSchema } from "./schemas.js";
import { duplicateOfferIssues, issuesFromZod, manifestFromConfig } from "./internal.js";
import type { CommerceConfig, Manifest } from "./schemas.js";

export function defineCommerce(config: CommerceConfig): Manifest {
  const parsed = CommerceConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = issuesFromZod(parsed.error);
    throw new Error(formatInvalidConfigMessage(issues));
  }

  const duplicateIssues = duplicateOfferIssues(parsed.data.offers);
  if (duplicateIssues.length) {
    throw new Error(formatInvalidConfigMessage(duplicateIssues));
  }

  return manifestFromConfig(parsed.data);
}

function formatInvalidConfigMessage(issues: { path: string; message: string }[]): string {
  return `Invalid commerce config: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
}
