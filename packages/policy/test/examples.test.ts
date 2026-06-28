import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicyFromString, type LintWarning } from "../src/schema/load.js";

const examplesDir = join(process.cwd(), "examples");
const snapshotsDir = join(examplesDir, "__snapshots__");

describe("example policies", () => {
  for (const file of readdirSync(examplesDir).filter((entry) => entry.endsWith(".yaml")).sort()) {
    it(`${file} loads and matches its lint snapshot`, () => {
      const { warnings } = loadPolicyFromString(readFileSync(join(examplesDir, file), "utf8"));
      const snapshot = JSON.parse(readFileSync(join(snapshotsDir, file.replace(/\.yaml$/, ".json")), "utf8")) as LintWarning[];

      expect(warnings).toEqual(snapshot);
    });
  }
});
