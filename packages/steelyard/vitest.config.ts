import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

type Tsconfig = {
  compilerOptions?: {
    paths?: Record<string, [string, ...string[]]>;
  };
};

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsconfig = JSON.parse(
  readFileSync(new URL("./tsconfig.json", import.meta.url), "utf8")
) as Tsconfig;

const alias = Object.entries(tsconfig.compilerOptions?.paths ?? {})
  .sort(([left], [right]) => right.length - left.length)
  .map(([specifier, paths]) => ({
    find: specifier,
    replacement: resolve(repoRoot, paths[0])
  }));

export default defineConfig({
  resolve: {
    alias
  }
});
