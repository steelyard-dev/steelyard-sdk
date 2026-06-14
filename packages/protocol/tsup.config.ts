import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "mcp/index": "src/mcp/index.ts",
    "acp/index": "src/acp/index.ts",
    "ucp/index": "src/ucp/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
