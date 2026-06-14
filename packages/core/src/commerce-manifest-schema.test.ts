// Copyright (c) Steelyard contributors. MIT License.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commerceSchemaPath = resolve(
  packageRoot,
  "spec",
  "commerce-manifest",
  "0.1",
  "commerce-manifest.schema.json"
);
const httpSchemaRoot = resolve(packageRoot, "spec", "http", "0.1");
const httpSchemaNames = [
  "capabilities_response.schema.json",
  "error.schema.json",
  "index_response.schema.json",
  "offer.schema.json",
  "policies_response.schema.json",
  "policy.schema.json",
  "products_response.schema.json"
];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(readJson(commerceSchemaPath));

  for (const schemaName of httpSchemaNames) {
    ajv.addSchema(readJson(resolve(httpSchemaRoot, schemaName)));
  }

  return ajv;
}

const offer = {
  id: "latte-12oz",
  title: "12oz Latte",
  description: "Espresso with steamed milk.",
  images: [],
  kind: "product",
  categories: ["coffee"],
  attributes: {
    caffeine_mg: 80,
    sizes: ["12oz", "16oz"],
    seasonal: false
  },
  availability: "in_stock",
  pricing: [{ kind: "one_time", amount: 550, currency: "USD" }]
};

const policy = {
  id: "returns",
  type: "returns",
  summary: "Unused beans may be returned within 14 days.",
  url: "https://coffee.example/returns"
};

const peers = {
  acp: {
    url: "https://coffee.example/acp/feed",
    protocol_version: "2026-04-17",
    steelyard_read_version: "0.1"
  },
  http: {
    url: "https://coffee.example/commerce",
    protocol_version: "0.1",
    steelyard_read_version: "0.1"
  }
};

describe("authored commerce schemas", () => {
  it("ships the expected v0.4 schema files", () => {
    expect(readdirSync(httpSchemaRoot).sort()).toEqual(httpSchemaNames);
  });

  it("compiles the manifest and HTTP schema registry", () => {
    const ajv = createAjv();

    for (const schemaName of httpSchemaNames) {
      const schema = readJson(resolve(httpSchemaRoot, schemaName));
      expect(ajv.getSchema(String(schema.$id))).toBeDefined();
    }
  });

  it("validates a representative commerce manifest document", () => {
    const ajv = createAjv();
    const validate = ajv.getSchema("https://steelyard.dev/schemas/commerce-manifest/0.1.json");
    expect(validate).toBeDefined();

    const doc = {
      $schema: "https://steelyard.dev/schemas/commerce-manifest/0.1.json",
      schema_version: "0.1",
      generated_at: "2026-06-14T00:00:00.000Z",
      identity: {
        name: "Acme Coffee",
        domain: "coffee.example",
        currencies: ["USD"]
      },
      offers: [offer],
      policies: [policy],
      peers,
      content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    };

    expect(validate?.(doc)).toBe(true);
  });

  it("validates representative HTTP read responses", () => {
    const ajv = createAjv();

    expect(ajv.getSchema("https://steelyard.dev/schemas/http/0.1/index_response.json")?.({
      schema_version: "0.1",
      links: {
        products: "/commerce/products",
        policies: "/commerce/policies",
        capabilities: "/commerce/capabilities"
      }
    })).toBe(true);
    expect(ajv.getSchema("https://steelyard.dev/schemas/http/0.1/products_response.json")?.({
      products: [offer],
      total: 1,
      offset: 0,
      limit: 1
    })).toBe(true);
    expect(ajv.getSchema("https://steelyard.dev/schemas/http/0.1/policies_response.json")?.({
      policies: [policy]
    })).toBe(true);
    expect(ajv.getSchema("https://steelyard.dev/schemas/http/0.1/capabilities_response.json")?.({
      peers
    })).toBe(true);
  });

  it("keeps the generated manifest type in sync with the schema", () => {
    expect(() =>
      execFileSync("node", ["scripts/generate-commerce-types.mjs", "--check"], {
        cwd: packageRoot,
        stdio: "pipe"
      })
    ).not.toThrow();
  });
});
