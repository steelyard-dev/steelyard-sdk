import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@steelyard/buyer/client", replacement: source("../buyer/src/client/index.ts") },
      { find: /^@steelyard\/core$/, replacement: source("../core/src/index.ts") },
      { find: "@steelyard/protocol/acp/checkout", replacement: source("../protocol/src/acp/checkout.ts") },
      { find: "@steelyard/protocol/acp", replacement: source("../protocol/src/acp/index.ts") },
      { find: "@steelyard/protocol/ucp/checkout", replacement: source("../protocol/src/ucp/checkout.ts") },
      { find: "@steelyard/protocol/ucp", replacement: source("../protocol/src/ucp/index.ts") }
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
