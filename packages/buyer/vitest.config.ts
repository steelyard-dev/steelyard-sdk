import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const targetedRun = process.argv.some((arg) => /^src\/.*\.test\.ts$/u.test(arg));

export default defineConfig({
  resolve: {
    alias: {
      "@steelyard/merchant/checkout": fileURLToPath(new URL("../merchant/src/checkout/index.ts", import.meta.url)),
      "@steelyard/merchant/mandate": fileURLToPath(new URL("../merchant/src/mandate/index.ts", import.meta.url)),
      "@steelyard/merchant/psp": fileURLToPath(new URL("../merchant/src/psp/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: targetedRun ? undefined : {
        lines: 95,
        functions: 90,
        branches: 88,
        statements: 95
      },
      include: ["src/client/**/*.ts", "src/policy/**/*.ts", "src/vault/**/*.ts", "src/wallet/**/*.ts"],
      exclude: [
        "src/**/*.test.ts"
      ]
    }
  }
});
