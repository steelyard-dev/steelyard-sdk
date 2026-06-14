import { normalizeMerchantDomain } from "./normalize.js";

export function domainMatches(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizeMerchantDomain(pattern);
  const normalizedCandidate = normalizeMerchantDomain(candidate);
  const patternParts = normalizedPattern.split(".");
  const candidateParts = normalizedCandidate.split(".");
  return matchParts(patternParts, candidateParts);
}

function matchParts(pattern: string[], candidate: string[]): boolean {
  if (!pattern.length) return candidate.length === 0;
  const [head, ...tail] = pattern;
  if (head === "**") {
    if (!tail.length) return candidate.length > 0;
    return candidate.some((_, index) => matchParts(tail, candidate.slice(index))) || matchParts(tail, candidate);
  }
  if (!candidate.length) return false;
  if (head === "*" || head === candidate[0]) return matchParts(tail, candidate.slice(1));
  return false;
}
