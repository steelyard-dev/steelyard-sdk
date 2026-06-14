import { defineConfig } from "tsup";

// Only /client is in exports today. /policy and /vault directories are scaffolded
// for the v2 buyer-side work but stay out of `exports` until they ship complete
// (no-stubs rule). When they're ready, add their entries here AND in package.json.
export default defineConfig({
  entry: {
    "client/index": "src/client/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
