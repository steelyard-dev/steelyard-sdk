import { defineConfig } from "tsup";

// /policy directory is scaffolded for the v2 merchant-side work but stays out
// of `exports` until it ships complete (no-stubs rule). When ready, add its
// entry here AND in package.json.
export default defineConfig({
  entry: {},
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
