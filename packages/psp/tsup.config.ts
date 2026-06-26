import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    conformance: "src/conformance.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
