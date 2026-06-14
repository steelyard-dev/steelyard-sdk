import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@steelyard/buyer/client", replacement: source("../../packages/buyer/src/client/index.ts") },
      { find: "@steelyard/buyer/policy", replacement: source("../../packages/buyer/src/policy/index.ts") },
      { find: "@steelyard/buyer/vault", replacement: source("../../packages/buyer/src/vault/index.ts") },
      { find: /^@steelyard\/buyer$/, replacement: source("../../packages/buyer/src/wallet/index.ts") },
      { find: /^@steelyard\/core$/, replacement: source("../../packages/core/src/index.ts") },
      { find: "@steelyard/protocol/acp", replacement: source("../../packages/protocol/src/acp/index.ts") },
      { find: "@steelyard/protocol/mcp", replacement: source("../../packages/protocol/src/mcp/index.ts") },
      { find: "@steelyard/protocol/ucp", replacement: source("../../packages/protocol/src/ucp/index.ts") }
    ]
  }
});
