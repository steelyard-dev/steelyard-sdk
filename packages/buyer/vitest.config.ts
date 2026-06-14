import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 95,
        functions: 90,
        branches: 70,
        statements: 95
      },
      include: ["src/client/**/*.ts", "src/vault/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // policy/ and wallet/ stay out of coverage until they have real code + tests.
        "src/policy/**",
        "src/wallet/**"
      ]
    }
  }
});
