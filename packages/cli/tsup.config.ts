import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "commands/validate": "src/commands/validate.ts",
    "commands/manifest": "src/commands/manifest.ts",
    "commands/doctor": "src/commands/doctor.ts"
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node"
  }
});
