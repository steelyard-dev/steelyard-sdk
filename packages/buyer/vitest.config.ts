import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
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
