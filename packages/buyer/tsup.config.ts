import { defineConfig } from "tsup";

// Root stays out of `exports` until the Wallet facade ships complete
// (no-stubs rule). When ready, add its entry here AND in package.json.
export default defineConfig({
  entry: {
    "client/index": "src/client/index.ts",
    "policy/index": "src/policy/index.ts",
    "vault/index": "src/vault/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
