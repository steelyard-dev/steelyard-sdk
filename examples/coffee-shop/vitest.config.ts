import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@steelyard/acp": source("../../packages/acp/src/index.ts"),
      "@steelyard/client": source("../../packages/client/src/index.ts"),
      "@steelyard/core": source("../../packages/core/src/index.ts"),
      "@steelyard/mcp": source("../../packages/mcp/src/index.ts"),
      "@steelyard/ucp": source("../../packages/ucp/src/index.ts")
    }
  }
});
