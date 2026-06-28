import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    client: "src/client.ts",
    server: "src/server.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false
});
