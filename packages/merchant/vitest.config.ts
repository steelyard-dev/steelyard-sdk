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
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts",
        // policy/ is scaffolded but not yet implemented.
        "src/policy/**"
      ]
    }
  }
});
