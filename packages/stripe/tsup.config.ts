import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    buyer: "src/buyer.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
