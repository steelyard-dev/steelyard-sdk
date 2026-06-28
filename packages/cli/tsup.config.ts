import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "commands/validate": "src/commands/validate.ts",
    "commands/manifest": "src/commands/manifest.ts",
    "commands/doctor": "src/commands/doctor.ts",
    "commands/policy/lint": "src/commands/policy/lint.ts",
    "commands/policy/run": "src/commands/policy/run.ts",
    "commands/policy/audit-verify": "src/commands/policy/audit-verify.ts"
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
