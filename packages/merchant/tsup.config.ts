import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "checkout/index": "src/checkout/index.ts",
    "policy/index": "src/policy/index.ts",
    "psp/index": "src/psp/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
