import { domainToASCII } from "node:url";

export function normalizeMerchantDomain(value: string): string {
  const trimmed = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    host = withoutScheme.split("/")[0] ?? withoutScheme;
    host = host.split(":")[0] ?? host;
  }
  return domainToASCII(host.toLowerCase().replace(/\.$/, ""));
}

export function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}
