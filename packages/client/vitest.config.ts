import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@steelyard/acp": source("../acp/src/index.ts"),
      "@steelyard/core": source("../core/src/index.ts"),
      "@steelyard/mcp": source("../mcp/src/index.ts"),
      "@steelyard/ucp": source("../ucp/src/index.ts")
    }
  },
  test: {
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 95
      }
    }
  }
});
