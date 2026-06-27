import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  target: "node20",
  onSuccess: async () => {
    mkdirSync("dist/templates", { recursive: true });
    cpSync("src/templates", "dist/templates", { recursive: true });
  }
});
