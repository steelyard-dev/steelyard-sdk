import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "client/acp": "src/client/acp.ts",
    "client/index": "src/client/index.ts",
    "client/ucp": "src/client/ucp.ts",
    "policy/index": "src/policy/index.ts",
    "vault/index": "src/vault/index.ts",
    "wallet/index": "src/wallet/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
