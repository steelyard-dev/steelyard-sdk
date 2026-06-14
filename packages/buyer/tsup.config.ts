import { defineConfig } from "tsup";

// /policy and root stay out of `exports` until their v0.2 criteria ship complete
// (no-stubs rule). When they're ready, add their entries here AND in package.json.
export default defineConfig({
  entry: {
    "client/index": "src/client/index.ts",
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
