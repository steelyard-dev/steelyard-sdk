import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts"
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
