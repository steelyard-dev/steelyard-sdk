import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(
  packageRoot,
  "spec",
  "commerce-manifest",
  "0.1",
  "commerce-manifest.schema.json"
);
const targetPath = resolve(packageRoot, "src", "generated", "commerce-manifest.types.ts");
const isCheck = process.argv.includes("--check");

const schema = {
  ...JSON.parse(readFileSync(schemaPath, "utf8")),
  title: "CommerceManifestDoc"
};
const generated = await compile(schema, "CommerceManifestDoc", {
  bannerComment: "// Generated from spec/commerce-manifest/0.1/commerce-manifest.schema.json. Do not edit.\n",
  style: {
    printWidth: 100,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "none"
  }
});
const content = `${generated.trimEnd()}

export type CommerceManifestPeer = Peer;
export type PeerName = "acp" | "ucp" | "mcp" | "http";
`;

if (isCheck) {
  if (!existsSync(targetPath)) {
    console.error(`${targetPath} does not exist; run pnpm --filter @steelyard-dev/core generate:types`);
    process.exit(1);
  }

  const current = readFileSync(targetPath, "utf8");
  if (current !== content) {
    console.error(`${targetPath} is out of date; run pnpm --filter @steelyard-dev/core generate:types`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content);
}
