import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@steelyard/buyer/client", replacement: source("../buyer/src/client/index.ts") },
      { find: /^@steelyard\/core$/, replacement: source("../core/src/index.ts") }
    ]
  },
  test: {
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 90
      }
    }
  }
});
