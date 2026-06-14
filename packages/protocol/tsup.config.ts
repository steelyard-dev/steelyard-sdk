import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "mcp/index": "src/mcp/index.ts",
    "commerce-manifest/index": "src/commerce-manifest/index.ts",
    "http/index": "src/http/index.ts",
    "acp/index": "src/acp/index.ts",
    "acp/checkout": "src/acp/checkout.ts",
    "ucp/index": "src/ucp/index.ts",
    "ucp/checkout": "src/ucp/checkout.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
