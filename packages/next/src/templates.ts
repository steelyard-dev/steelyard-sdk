// Copyright (c) Steelyard contributors. MIT License.
//
// Template loaders. We ship template files (page.tpl.tsx, route.tpl.ts) as
// raw assets under dist/templates/. Consumers (the CLI) read them as strings
// and write them into user repos. Doing this via .tpl files (not real .tsx)
// keeps the template out of our own tsc/tsup graph — we don't want to
// type-check it against our own deps; it type-checks in the user's project.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the directory of THIS module across ESM and CJS.
// In ESM, import.meta.url is set; in CJS, tsup leaves it empty, so we fall
// back to __dirname (injected by Node's CJS wrapper at runtime).
function moduleDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = (import.meta as any)?.url as string | undefined;
    if (url) return dirname(fileURLToPath(url));
  } catch {
    // import.meta not available — fall through
  }
  // CJS fallback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__dirname ?? __dirname;
}

const here = moduleDir();
// Sibling `templates/` dir — present alongside src/ in dev and alongside the
// built entry in dist/. The dir is co-located with this module either way.
const templatesDir = resolve(here, "templates");

export function loadInspectorPageTemplate(): string {
  return readFileSync(resolve(templatesDir, "inspector-page.tpl.tsx"), "utf8");
}
