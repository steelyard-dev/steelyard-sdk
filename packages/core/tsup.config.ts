import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "policy-yaml/index": "src/policy-yaml/index.ts",
    "order-state": "src/order-state.ts",
    "idempotency/index": "src/idempotency/index.ts",
    purchase: "src/purchase.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
