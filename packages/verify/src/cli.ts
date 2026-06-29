#!/usr/bin/env node
// Copyright (c) Steelyard contributors. MIT License.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSignatureBase,
  contentDigestHeader,
  ecdsaSignRaw,
  ecdsaVerifyRaw,
  parseSf941Dict,
  serializeSf941Dict,
  type EcJwk
} from "@steelyard-dev/core";
import { fetchUcpProfile, type UcpProfileFetchErrorCode } from "@steelyard-dev/protocol/ucp";

type VerifyStatus = "passed" | "failed" | "skipped";

interface VerifyCase {
  id: string;
  suite: string;
  title: string;
  verifies: string[];
  evidence: string[];
  lanes?: string[];
  run(ctx: VerifyContext): Promise<void>;
}

interface VerifyResult {
  id: string;
  suite: string;
  title: string;
  verifies: string[];
  status: VerifyStatus;
  evidence: string[];
  duration_ms: number;
  error?: string;
}

interface VerifyReport {
  generated_at: string;
  lane?: string;
  filters: {
    suites: string[];
    audit: boolean;
    check_clocks: boolean;
    check_mock_guards: boolean;
  };
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  };
  results: VerifyResult[];
}

interface VerifyArgs {
  suites: string[];
  lane?: string;
  audit: boolean;
  checkClocks: boolean;
  checkMockGuards: boolean;
}

interface VerifyContext {
  repoRoot: string;
  args: VerifyArgs;
  commandCache: Map<string, Promise<void>>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const REQUIRED_FINDINGS = [
  ...findingRange("F", 1, 40),
  ...findingRange("NF", 1, 7),
  ...findingRange("NNF", 1, 6)
];

const FINDING_COVERAGE: Record<string, string[]> = {
  F1: ["VR-03", "VR-12"],
  F2: ["VR-06"],
  F3: ["VR-07", "VR-08"],
  F4: ["VI-04", "VI-05"],
  F5: ["VI-03"],
  F6: ["VR-13", "VBuild-08"],
  F7: ["VI-06"],
  F8: ["VSec-07", "VSec-08", "VCI-11"],
  F9: ["VS-ACP-04", "VS-ACP-05", "VS-ACP-06", "VS-ACP-07"],
  F10: ["VS-ACP-09", "VS-ACP-10"],
  F11: ["VH-01", "VH-02", "VH-03", "VH-04", "VS-UCP-11"],
  F12: ["VPSP-01", "VPSP-02", "VPSP-03"],
  F13: ["VS-UCP-03", "VS-UCP-06", "VS-UCP-07", "VPSP-04"],
  F14: ["VS-UCP-08", "VS-UCP-09", "VS-MD-01", "VS-MD-02", "VS-MD-03", "VM-06"],
  F15: ["VS-MD-04", "VS-MD-05", "VM-02"],
  F16: ["VPSP-04", "VPSP-05", "VPSP-06"],
  F17: ["VSM-ACP-03", "VSM-ACP-04", "VSM-UCP-02", "VR-09", "VR-10", "VR-11"],
  F18: ["VBuild-09"],
  F19: ["VBC-01"],
  F20: ["VBC-03", "VBC-04"],
  F21: ["VBC-07"],
  F22: ["VBC-05", "VBC-06"],
  F23: ["VSec-10", "VM-07"],
  F24: ["VS-MD-06", "VS-MD-07", "VM-08"],
  F25: ["VH-07", "VH-08", "VH-09"],
  F26: ["VI-01", "VI-02", "VI-07", "VI-08"],
  F27: ["VD-01", "VD-02", "VD-03", "VD-04", "VD-05", "VD-06"],
  F28: ["VS-ACP-01", "VS-ACP-02", "VBuild-01", "VBuild-02", "VBuild-03"],
  F29: ["VS-UCP-01", "VS-UCP-02", "VS-UCP-03"],
  F30: ["VSM-ACP-01", "VSM-UCP-01", "VSM-UCP-06"],
  F31: ["VR-04"],
  F32: ["VH-05", "VH-06"],
  F33: ["VSec-01", "VSec-02"],
  F34: ["VSec-03", "VSec-04", "VSec-05", "VSec-06"],
  F35: ["VCI-01", "VCI-02", "VCI-03", "VCI-04"],
  F36: ["VBuild-05", "VBuild-06"],
  F37: ["VBuild-04", "VBuild-07"],
  F38: ["VBuild-10", "VBuild-11"],
  F39: ["VBuild-08"],
  F40: ["VBC-01", "docs:migration"],
  NF1: ["VR-09", "VBC-07"],
  NF2: ["VS-UCP-10", "VS-UCP-11"],
  NF3: ["VR-07", "VR-08"],
  NF4: ["VBC-03", "VBC-04", "VBC-05"],
  NF5: ["VD-04", "VD-05", "VS-UCP-09"],
  NF6: ["VR-06"],
  NF7: ["VSec-03", "VSec-04", "VSec-05", "VSec-06"],
  NNF1: ["VS-ACP-11", "VH-01"],
  NNF2: ["VS-ACP-04", "VS-UCP-06", "VD-03", "VD-04", "VPSP-04"],
  NNF3: ["VS-ACP-04", "VPSP-01"],
  NNF4: ["VPSP-04"],
  NNF5: ["VS-UCP-06"],
  NNF6: ["VBC-03", "VBC-04", "VBC-05"]
};

const INVERSE_COVERAGE = invertCoverage(FINDING_COVERAGE);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx: VerifyContext = { repoRoot, args, commandCache: new Map() };
  const cases = selectCases(buildCases(), args);
  const results: VerifyResult[] = [];

  for (const test of cases) {
    const started = performance.now();
    if (args.lane && test.lanes && !test.lanes.includes(args.lane)) {
      results.push(resultFor(test, "skipped", started));
      continue;
    }
    try {
      await test.run(ctx);
      results.push(resultFor(test, "passed", started));
    } catch (error) {
      results.push(resultFor(test, "failed", started, error));
    }
  }

  if (args.audit || shouldRunDefaultAudit(args)) {
    results.push(...await runAudit(ctx));
  }

  const report = buildReport(args, results);
  await writeReport(ctx, report);
  printSummary(report);
  if (report.summary.failed > 0) process.exitCode = 1;
}

function buildCases(): VerifyCase[] {
  const cases: VerifyCase[] = [];
  addBehavioralCases(cases);
  addStaticCases(cases);
  return cases;
}

function addBehavioralCases(cases: VerifyCase[]): void {
  const behavioral = runBehavioralSuites;
  addCases(cases, "VS", range("VS-ACP-", 1, 13), "ACP schema conformance", behavioral);
  addCases(cases, "VS", range("VS-UCP-", 1, 11), "UCP schema conformance", behavioral);
  addCases(cases, "VS", range("VS-MD-", 1, 7), "Steelyard mandate JWS conformance", behavioral);
  addCases(cases, "VSM", range("VSM-ACP-", 1, 19), "ACP status-machine conformance", behavioral);
  addCases(cases, "VSM", range("VSM-UCP-", 1, 6), "UCP status-machine conformance", behavioral);
  addCases(cases, "VI", range("VI-", 1, 8), "Idempotency conformance", behavioral);
  addCases(cases, "VH", ["VH-01", "VH-02", "VH-03", "VH-06", "VH-07", "VH-08", "VH-09"], "Helper conformance", behavioral);
  addCases(cases, "VR", range("VR-", 1, 13), "Reservation lifecycle", behavioral);
  addCases(cases, "VM", range("VM-", 1, 8), "Mandate conformance", behavioral);
  addCases(cases, "VSec", ["VSec-01", "VSec-02", "VSec-08", "VSec-09", "VSec-10"], "Security conformance", behavioral);
  addCases(cases, "VP", range("VP-", 1, 5), "Cross-protocol parity", behavioral);
  addCases(cases, "VBC", range("VBC-", 1, 8), "Backward compatibility", behavioral);
  addCases(cases, "VD", range("VD-", 1, 6), "Discovery capability sniffing", behavioral);
  addCases(cases, "VPSP", range("VPSP-", 1, 6), "PSP handler selection", behavioral);
  addV041ConformanceCases(cases);
  addV042SignatureConformanceCases(cases);
  addV05Ap2ConformanceCases(cases);
  addV06StripeConformanceCases(cases);
  addV07AdapterConformanceCases(cases);
  cases.push({
    id: "docs:migration",
    suite: "docs",
    title: "Migration guide covers v0.3 behavioral changes",
    verifies: ["F40"],
    evidence: ["docs/guides/migrating-from-v0.2.md", "README.md"],
    run: assertMigrationDocs
  });
}

function addV07AdapterConformanceCases(cases: VerifyCase[]): void {
  const entries: Array<[string, string, string[], (ctx: VerifyContext) => Promise<void>]> = [
    [
      "V07-NC-01",
      "UCP payment handlers derive from PSP accepted instruments",
      ["packages/protocol/src/ucp/ucp.test.ts", "packages/merchant/src/checkout/server.test.ts", "NC1", "MV2", "AD3"],
      async (ctx) => {
        await runFocusedVitest(ctx, "v06-protocol-ucp", "@steelyard-dev/protocol", "src/ucp/ucp.test.ts");
        await runFocusedVitest(ctx, "v07-merchant-checkout", "@steelyard-dev/merchant", "src/checkout/server.test.ts");
      }
    ],
    [
      "V07-BN-01",
      "Buyer UCP requires advertised instruments and carries issuer instrument types",
      ["packages/buyer/src/client/checkout-drivers.test.ts", "BN2", "BN3"],
      (ctx) => runFocusedVitest(ctx, "v06-buyer-checkout-drivers", "@steelyard-dev/buyer", "src/client/checkout-drivers.test.ts")
    ],
    [
      "V07-RP-01",
      "Reference issuer and PSP sign and verify delegated payment tokens",
      ["packages/buyer/src/reference-payment.test.ts", "packages/merchant/src/psp/psp.test.ts", "RP1", "RP2", "RP3"],
      async (ctx) => {
        await runFocusedVitest(ctx, "v07-buyer-reference-payment", "@steelyard-dev/buyer", "src/reference-payment.test.ts");
        await runFocusedVitest(ctx, "v06-merchant-psp", "@steelyard-dev/merchant", "src/psp/psp.test.ts");
      }
    ],
    [
      "V07-AG-01",
      "ACP rejects non-SPT payment mandate issuers before minting",
      ["packages/buyer/src/client/checkout-drivers.test.ts", "AG1"],
      (ctx) => runFocusedVitest(ctx, "v06-buyer-checkout-drivers", "@steelyard-dev/buyer", "src/client/checkout-drivers.test.ts")
    ],
    [
      "V07-EX-01",
      "Coffee-shop dual UCP smoke compares Stripe-backed and reference-backed configs",
      ["examples/coffee-shop/scripts/smoke-dual-ucp.ts", "EX1"],
      (ctx) =>
        runCommandOnce(ctx, "v07-coffee-shop-dual-ucp", "pnpm", [
          "--filter",
          "steelyard-example-coffee-shop",
          "smoke:ucp:dual"
        ], {
          STEELYARD_MOCK_STRIPE: "1",
          STEELYARD_ALLOW_REFERENCE_PSP: "1",
          STRIPE_TEST_SECRET_KEY: "sk_test_mock"
        })
    ],
    [
      "V07-IN-01",
      "Public docs describe payment adapters and ACP's Stripe-only boundary",
      ["CHANGELOG.md", "docs/releases.md", "docs/concepts/payment-adapters.md", "README.md", "IN3", "IN5"],
      assertV07PaymentAdapterDocs
    ]
  ];
  for (const [id, title, evidence, run] of entries) {
    cases.push({
      id,
      suite: "V07",
      title,
      verifies: [],
      evidence,
      run
    });
  }
}

function addV06StripeConformanceCases(cases: VerifyCase[]): void {
  const entries: Array<[string, string, string[], (ctx: VerifyContext) => Promise<void>]> = [
    [
      "VSPT-01",
      "Stripe SPT primitives mint, charge, normalize errors, and reject live keys",
      ["packages/core/src/stripe/index.test.ts", "SP1", "SP2", "SP3", "SP4"],
      (ctx) => runFocusedVitest(ctx, "v06-core-stripe", "@steelyard-dev/core", "src/stripe/index.test.ts")
    ],
    [
      "VSI-01",
      "Buyer Stripe SPT issuer binds AP2 mandate scope and refuses widening",
      ["packages/stripe/src/buyer.test.ts", "SI1", "SI2", "SI3", "SI4"],
      (ctx) => runFocusedVitest(ctx, "v06-stripe-buyer", "@steelyard-dev/stripe", "src/buyer.test.ts")
    ],
    [
      "VSC-01",
      "Merchant PSP discriminates SPTs and verifies AP2 payment mandates before Stripe capture",
      ["packages/merchant/src/psp/psp.test.ts", "SC1", "SC2", "SC3", "SC4", "AP1", "AP2", "AP3", "AP4"],
      (ctx) => runFocusedVitest(ctx, "v06-merchant-psp", "@steelyard-dev/merchant", "src/psp/psp.test.ts")
    ],
    [
      "VUH-01",
      "UCP payment_handlers advertise Stripe and buyer checkout selects compatible handlers",
      ["packages/protocol/src/ucp/ucp.test.ts", "packages/buyer/src/client/checkout-drivers.test.ts", "UH1", "UH2", "UH3", "UH4"],
      async (ctx) => {
        await runFocusedVitest(ctx, "v06-protocol-ucp", "@steelyard-dev/protocol", "src/ucp/ucp.test.ts");
        await runFocusedVitest(ctx, "v06-buyer-checkout-drivers", "@steelyard-dev/buyer", "src/client/checkout-drivers.test.ts");
      }
    ],
    [
      "VACP-01",
      "ACP checkout REST accepts direct SPT payment_data and buyer emits exact request shapes",
      ["packages/protocol/src/acp/checkout.test.ts", "packages/buyer/src/client/checkout-drivers.test.ts", "AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AB1", "AB2", "AB3", "AB4", "AB5", "AP5"],
      async (ctx) => {
        await runFocusedVitest(ctx, "v06-protocol-acp-checkout", "@steelyard-dev/protocol", "src/acp/checkout.test.ts");
        await runFocusedVitest(ctx, "v06-buyer-checkout-drivers", "@steelyard-dev/buyer", "src/client/checkout-drivers.test.ts");
      }
    ],
    [
      "VEX-01",
      "Coffee-shop mock Stripe smokes and vanilla ACP interop stay offline-safe",
      ["examples/coffee-shop/scripts/smoke-stripe-ucp.ts", "examples/coffee-shop/scripts/smoke-stripe-acp.ts", "examples/coffee-shop/src/acp-interop.test.ts", "EX1", "EX2", "EX4", "EX5"],
      async (ctx) => {
        await runCommandOnce(ctx, "v06-coffee-shop-stripe-ucp-mock", "pnpm", [
          "--filter",
          "steelyard-example-coffee-shop",
          "smoke:stripe:ucp"
        ], { STEELYARD_MOCK_STRIPE: "1", STRIPE_TEST_SECRET_KEY: "sk_test_mock" });
        await runCommandOnce(ctx, "v06-coffee-shop-stripe-acp-mock", "pnpm", [
          "--filter",
          "steelyard-example-coffee-shop",
          "smoke:stripe:acp"
        ], { STEELYARD_MOCK_STRIPE: "1", STRIPE_TEST_SECRET_KEY: "sk_test_mock" });
        await runFocusedVitest(ctx, "v06-coffee-shop-tests", "steelyard-example-coffee-shop", "src/acp-interop.test.ts");
      }
    ]
  ];
  for (const [id, title, evidence, run] of entries) {
    cases.push({
      id,
      suite: "V06",
      title,
      verifies: [],
      evidence,
      run
    });
  }
}

function addV05Ap2ConformanceCases(cases: VerifyCase[]): void {
  const entries: Array<[string, string, string[], (ctx: VerifyContext) => Promise<void>]> = [
    [
      "VAP2-01",
      "AP2 checkout mandate is SD-JWT+KB with KB-JWT sd_hash",
      ["packages/buyer/src/vault/mandate-ap2.test.ts", "RFC 9901 Section 4.3"],
      (ctx) => runFocusedVitest(ctx, "vap2-buyer-mandate-ap2", "@steelyard-dev/buyer", "src/vault/mandate-ap2.test.ts")
    ],
    [
      "VAP2-02",
      "AP2 payment mandate uses mandate.payment.1 claims",
      ["packages/buyer/src/vault/mandate-ap2.test.ts", "AP2 mandate.payment.1"],
      (ctx) => runFocusedVitest(ctx, "vap2-buyer-mandate-ap2", "@steelyard-dev/buyer", "src/vault/mandate-ap2.test.ts")
    ],
    [
      "VAP2-03",
      "PSP adapters verify AP2 payment mandates before capture",
      ["packages/merchant/src/psp/psp.test.ts", "PM5-3"],
      (ctx) => runFocusedVitest(ctx, "vap2-merchant-psp", "@steelyard-dev/merchant", "src/psp/psp.test.ts")
    ],
    [
      "VAP2-04",
      "AP2 envelope validation accepts SD-JWT+KB shape and defers signature checks",
      ["packages/protocol/src/ucp/ap2-envelope.test.ts", "SC5-2"],
      (ctx) => runFocusedVitest(ctx, "vap2-protocol-ap2-envelope", "@steelyard-dev/protocol", "src/ucp/ap2-envelope.test.ts")
    ],
    [
      "VBV-01",
      "Merchant authorization signer emits AP2 detached JWS",
      ["packages/merchant/src/mandate/ap2.test.ts", "MA5-1"],
      (ctx) => runFocusedVitest(ctx, "vbv-merchant-ap2", "@steelyard-dev/merchant", "src/mandate/ap2.test.ts")
    ],
    [
      "VBV-02",
      "Buyer verifies AP2 merchant authorization before complete",
      ["packages/buyer/src/client/checkout-drivers.test.ts", "BV5"],
      (ctx) => runFocusedVitest(ctx, "vbv-buyer-ucp-driver", "@steelyard-dev/buyer", "src/client/checkout-drivers.test.ts")
    ],
    [
      "VBV-03",
      "Merchant mounts AP2 merchant authorization on locked checkout responses",
      ["packages/merchant/src/checkout/server.test.ts", "MA5-2", "DI5-3"],
      (ctx) => runFocusedVitest(ctx, "vbv-merchant-checkout", "@steelyard-dev/merchant", "src/checkout/server.test.ts")
    ],
    [
      "VNO-01",
      "AP2 nonce store is single-use and file-backed",
      ["packages/merchant/src/mandate/nonce.test.ts", "NO5-1", "NO5-2"],
      (ctx) => runFocusedVitest(ctx, "vno-merchant-nonce", "@steelyard-dev/merchant", "src/mandate/nonce.test.ts")
    ],
    [
      "VNO-02",
      "AP2 verifier consumes checkout nonces and rejects replay",
      ["packages/merchant/src/mandate/ap2-verifier.test.ts", "VE5-2", "NO5-2"],
      (ctx) => runFocusedVitest(ctx, "vno-merchant-ap2-verifier", "@steelyard-dev/merchant", "src/mandate/ap2-verifier.test.ts")
    ],
    [
      "VNO-03",
      "Coffee-shop AP2 smoke completes with merchant-issued nonces",
      ["examples/coffee-shop/scripts/smoke-ap2.ts", "IN5-2"],
      (ctx) =>
        runCommandOnce(ctx, "vno-coffee-shop-ap2-smoke", "pnpm", [
          "--filter",
          "steelyard-example-coffee-shop",
          "tsx",
          "scripts/smoke-ap2.ts"
        ])
    ]
  ];
  for (const [id, title, evidence, run] of entries) {
    cases.push({
      id,
      suite: id.split("-")[0] ?? "AP2",
      title,
      verifies: [],
      evidence,
      run
    });
  }
}

function addV041ConformanceCases(cases: VerifyCase[]): void {
  const entries: Array<[string, string, string[], (ctx: VerifyContext) => Promise<void>]> = [
    [
      "VK1",
      "Canonical UCP discovery uses full capability keys",
      ["packages/protocol/src/ucp/ucp.test.ts"],
      (ctx) => runFocusedVitest(ctx, "vk-protocol-ucp", "@steelyard-dev/protocol", "src/ucp/ucp.test.ts")
    ],
    [
      "VK2",
      "Legacy UCP bucket/id discovery still sniffs during migration",
      ["packages/buyer/src/client/client.test.ts"],
      (ctx) => runFocusedVitest(ctx, "vk-buyer-client", "@steelyard-dev/buyer", "src/client/client.test.ts")
    ],
    [
      "VK3",
      "Vanilla UCP complete succeeds without a Steelyard mandate",
      ["packages/merchant/src/checkout/server.test.ts"],
      (ctx) => runFocusedVitest(ctx, "vk-merchant-checkout", "@steelyard-dev/merchant", "src/checkout/server.test.ts")
    ],
    [
      "VK4",
      "Steelyard-mode UCP complete still verifies mandates",
      ["packages/merchant/src/checkout/server.test.ts", "packages/buyer/src/client/checkout-drivers.test.ts"],
      async (ctx) => {
        await runFocusedVitest(ctx, "vk-merchant-checkout", "@steelyard-dev/merchant", "src/checkout/server.test.ts");
        await runFocusedVitest(ctx, "vk-buyer-ucp-driver", "@steelyard-dev/buyer", "src/client/checkout-drivers.test.ts");
      }
    ]
  ];
  for (const [id, title, evidence, run] of entries) {
    cases.push({
      id,
      suite: "VK",
      title,
      verifies: ["VE1"],
      evidence,
      run
    });
  }
}

function addV042SignatureConformanceCases(cases: VerifyCase[]): void {
  const entries: Array<[string, string, string[], (ctx: VerifyContext) => Promise<void>]> = [
    [
      "AP-VS1",
      "RFC 9421 B.2.5 request signature base is byte-identical",
      ["packages/core/src/rfc9421.ts", "RFC 9421 B.2.5"],
      assertRfc9421B25SignatureBase
    ],
    [
      "AP-VS2",
      "RFC 9421 ECC example key signs and verifies the worked example",
      ["packages/core/src/rfc9421.ts", "RFC 9421 B.1.3", "RFC 9421 B.2.4"],
      assertRfc9421EccExampleSignsAndVerifies
    ],
    [
      "AP-VS3",
      "RFC 9530 Appendix B Content-Digest examples round-trip",
      ["packages/core/src/rfc9421.ts", "RFC 9530 Appendix B"],
      assertRfc9530ContentDigestExamples
    ],
    [
      "AP-VS4",
      "RFC 8941 dictionary parser round-trips structured field examples",
      ["packages/core/src/rfc9421.ts", "RFC 8941 Section 3.2"],
      assertRfc8941DictionaryExamples
    ],
    [
      "AP-VS5",
      "ECDSA helpers emit fixed-width raw r||s for ES256 and ES384",
      ["packages/core/src/rfc9421.ts", "protocols/ucp/docs/specification/signatures.md"],
      assertEcdsaRawSignatureWidths
    ],
    [
      "AP-VS6",
      "UCP profile fetch rejects unsafe or unbounded responses",
      ["packages/protocol/src/ucp/profile.ts", "protocols/ucp/docs/specification/overview.md"],
      assertProfileFetchRejectionModes
    ]
  ];
  for (const [id, title, evidence, run] of entries) {
    cases.push({
      id,
      suite: "AP",
      title,
      verifies: ["IN3"],
      evidence,
      run
    });
  }
}

async function runFocusedVitest(ctx: VerifyContext, key: string, pkg: string, testFile: string): Promise<void> {
  await runCommandOnce(ctx, key, "pnpm", [
    "--filter",
    pkg,
    "exec",
    "vitest",
    "run",
    testFile,
    "--coverage.enabled=false"
  ]);
}

function addStaticCases(cases: VerifyCase[]): void {
  cases.push({
    id: "VH-04",
    suite: "VH",
    title: "Protocol amount reads go through totalAmount()",
    verifies: INVERSE_COVERAGE["VH-04"] ?? [],
    evidence: ["packages/buyer/src/client", "packages/protocol/src/acp", "packages/protocol/src/ucp"],
    run: assertNoDirectTotalsTotal
  });
  cases.push({
    id: "VH-05",
    suite: "VH",
    title: "Source timing flows through clock parameters",
    verifies: INVERSE_COVERAGE["VH-05"] ?? [],
    evidence: ["packages/{buyer,merchant,protocol,core}/src"],
    run: assertNoSourceSystemTime
  });
  cases.push({
    id: "VSec-03",
    suite: "VSec",
    title: "mockPsp default-denies outside known test environments",
    verifies: INVERSE_COVERAGE["VSec-03"] ?? [],
    evidence: ["packages/merchant/src/psp/adapters.ts"],
    run: assertMockPspGuard
  });
  cases.push({
    id: "VSec-04",
    suite: "VSec",
    title: "mockPsp requires env opt-in in addition to allowInProduction",
    verifies: INVERSE_COVERAGE["VSec-04"] ?? [],
    evidence: ["packages/merchant/src/psp/adapters.ts"],
    run: assertMockPspGuard
  });
  cases.push({
    id: "VSec-05",
    suite: "VSec",
    title: "mockPsp accepts explicit demo opt-in",
    verifies: INVERSE_COVERAGE["VSec-05"] ?? [],
    evidence: ["packages/merchant/src/psp/adapters.ts", "packages/merchant/src/psp/psp.test.ts"],
    run: assertMockPspGuard
  });
  cases.push({
    id: "VSec-06",
    suite: "VSec",
    title: "mockMandateVerifier mirrors mockPsp production guards",
    verifies: INVERSE_COVERAGE["VSec-06"] ?? [],
    evidence: ["packages/merchant/src/mandate/verifier.ts", "packages/merchant/src/mandate/mandate.test.ts"],
    run: assertMockMandateGuard
  });
  cases.push({
    id: "VSec-07",
    suite: "VSec",
    title: "Merchant checkout does not mount delegate_payment or PAN-receiving routes",
    verifies: INVERSE_COVERAGE["VSec-07"] ?? [],
    evidence: ["packages/merchant/src/checkout/server.ts", "examples/coffee-shop/scripts/scan-routes.ts"],
    run: assertNoMerchantDelegateRoute
  });

  addVciCases(cases);
  addVBuildCases(cases);
}

function addVciCases(cases: VerifyCase[]): void {
  const allLanes = ["macos-keychain", "ubuntu-keychain", "ubuntu-password"];
  const linuxKeychain = ["ubuntu-keychain"];
  const passwordLane = ["ubuntu-password"];
  const macosLane = ["macos-keychain"];
  const entries: Array<[string, string, string[], (ctx: VerifyContext) => Promise<void>]> = [
    ["VCI-01", "CI runs pnpm build", allLanes, (ctx) => assertWorkflowContains(ctx, "pnpm build")],
    ["VCI-02", "CI runs pnpm typecheck", allLanes, (ctx) => assertWorkflowContains(ctx, "pnpm typecheck")],
    ["VCI-03", "CI runs pnpm lint", allLanes, (ctx) => assertWorkflowContains(ctx, "pnpm lint")],
    ["VCI-04", "CI runs pnpm test", allLanes, (ctx) => assertWorkflowContains(ctx, "pnpm test")],
    ["VCI-05", "CI runs ACP buy-real example", allLanes, (ctx) => assertWorkflowContains(ctx, "buy:real -- --protocol acp")],
    ["VCI-06", "CI runs UCP buy-real example", allLanes, (ctx) => assertWorkflowContains(ctx, "buy:real -- --protocol ucp")],
    ["VCI-07", "macOS keychain lane exercises mandate keys", macosLane, (ctx) => assertWorkflowContains(ctx, "macos-latest")],
    ["VCI-08", "Ubuntu keychain lane keeps dbus scope", linuxKeychain, assertLinuxKeychainWorkflow],
    ["VCI-09", "Ubuntu password lane is present", passwordLane, (ctx) => assertWorkflowContains(ctx, "lane: password")],
    ["VCI-10", "CI covers file store CAS behavior through tests", allLanes, (ctx) => assertWorkflowContains(ctx, "pnpm test")],
    ["VCI-11", "CI scans coffee-shop routes for delegate_payment", allLanes, (ctx) => assertWorkflowContains(ctx, "scan:routes")],
    ["VCI-12", "CI validates commerce manifests from examples", allLanes, (ctx) => assertWorkflowContains(ctx, "pnpm validate-examples")]
  ];
  for (const [id, title, lanes, run] of entries) {
    cases.push({
      id,
      suite: "VCI",
      title,
      lanes,
      verifies: INVERSE_COVERAGE[id] ?? [],
      evidence: [".github/workflows/ci.yml"],
      run
    });
  }
}

function addVBuildCases(cases: VerifyCase[]): void {
  const entries: Array<[string, string, (ctx: VerifyContext) => Promise<void>]> = [
    ["VBuild-01", "ACP checkout schemas are vendored", assertAcpSpecVendored],
    ["VBuild-02", "UCP shopping schemas are vendored", assertUcpSpecVendored],
    ["VBuild-03", "Protocol build copies vendored schemas to dist", assertProtocolDistSpecs],
    ["VBuild-04", "Core subpath exports are explicit", (ctx) => assertPackageExports(ctx, "packages/core/package.json", [".", "./policy-yaml", "./order-state", "./idempotency", "./purchase"])],
    ["VBuild-05", "Merchant subpath exports are explicit", (ctx) => assertPackageExports(ctx, "packages/merchant/package.json", [".", "./checkout", "./policy", "./psp", "./mandate"])],
    ["VBuild-06", "Merchant build/test/typecheck scripts run real tools", assertMerchantScriptsReal],
    ["VBuild-07", "Buyer subpath exports are explicit", (ctx) => assertPackageExports(ctx, "packages/buyer/package.json", [".", "./policy", "./vault", "./client", "./client/acp", "./client/ucp"])],
    ["VBuild-08", "Merchant checkout routes are Node http handlers", assertNodeHttpRoutes],
    ["VBuild-09", "Wallet class has no public vault/policy/mandate/payment escape hatches", assertWalletFacadeClosed],
    ["VBuild-10", "ACP protocol checkout has no merchant or fs imports", (ctx) => assertProtocolBoundary(ctx, "packages/protocol/src/acp/checkout.ts")],
    ["VBuild-11", "UCP protocol checkout has no merchant or fs imports", (ctx) => assertProtocolBoundary(ctx, "packages/protocol/src/ucp/checkout.ts")]
  ];
  for (const [id, title, run] of entries) {
    cases.push({
      id,
      suite: "VBuild",
      title,
      verifies: INVERSE_COVERAGE[id] ?? [],
      evidence: ["VERIFY.md"],
      run
    });
  }
}

function addCases(
  cases: VerifyCase[],
  suite: string,
  ids: string[],
  title: string,
  run: (ctx: VerifyContext) => Promise<void>
): void {
  for (const id of ids) {
    cases.push({
      id,
      suite,
      title,
      verifies: INVERSE_COVERAGE[id] ?? [],
      evidence: ["pnpm test"],
      run
    });
  }
}

async function runBehavioralSuites(ctx: VerifyContext): Promise<void> {
  await runCommandOnce(ctx, "pnpm-test", "pnpm", ["test"]);
}

async function assertRfc9421B25SignatureBase(): Promise<void> {
  const base = buildSignatureBase({
    method: "POST",
    authority: "example.com",
    path: "/foo",
    headers: {
      date: "Tue, 20 Apr 2021 02:07:55 GMT",
      "content-type": "application/json"
    },
    components: ["date", "@authority", "content-type"],
    parameters: { created: 1618884473, keyid: "test-shared-secret" }
  });

  assertEqual(
    text(base),
    [
      "\"date\": Tue, 20 Apr 2021 02:07:55 GMT",
      "\"@authority\": example.com",
      "\"content-type\": application/json",
      "\"@signature-params\": (\"date\" \"@authority\" \"content-type\");created=1618884473;keyid=\"test-shared-secret\""
    ].join("\n"),
    "RFC 9421 B.2.5 signature base mismatch"
  );
}

async function assertRfc9421EccExampleSignsAndVerifies(): Promise<void> {
  const base = buildSignatureBase({
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-digest":
        "sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:",
      "content-length": "23"
    },
    components: ["@status", "content-type", "content-digest", "content-length"],
    parameters: { created: 1618884473, keyid: "test-key-ecc-p256" }
  });
  const expectedSignature = Buffer.from(
    "wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==",
    "base64"
  );
  assertEqual(expectedSignature.byteLength, 64, "RFC 9421 B.2.4 example signature must be 64 raw bytes");
  assert(
    await ecdsaVerifyRaw({
      algorithm: "ES256",
      publicKeyJwk: rfc9421P256.publicJwk,
      data: base,
      signature: expectedSignature
    }),
    "RFC 9421 B.2.4 example signature must verify with the example public key"
  );

  const generated = await ecdsaSignRaw({
    algorithm: "ES256",
    privateKeyJwk: rfc9421P256.privateJwk,
    data: base
  });
  assertEqual(generated.byteLength, 64, "generated ES256 signature must be 64 raw bytes");
  assert(
    await ecdsaVerifyRaw({
      algorithm: "ES256",
      publicKeyJwk: rfc9421P256.publicJwk,
      data: base,
      signature: generated
    }),
    "generated RFC 9421 example signature must verify with the example public key"
  );
}

async function assertRfc9530ContentDigestExamples(): Promise<void> {
  const fullRepresentation = Buffer.from("{\"hello\": \"world\"}\n", "utf8");
  const partialContent = Buffer.from("\"world\"}\n", "utf8");
  const examples = [
    [fullRepresentation, "sha-256=:RK/0qy18MlBSVnWgjwz6lZEWjP/lF5HF9bvEF8FabDg=:"],
    [new Uint8Array(), "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:"],
    [partialContent, "sha-256=:jjcgBDWNAtbYUXI37CVG3gRuGOAjaaDRGpIUFsdyepQ=:"]
  ] as const;

  for (const [body, expected] of examples) {
    const actual = contentDigestHeader({ body });
    assertEqual(actual, expected, `Content-Digest mismatch for RFC 9530 body ${text(body)}`);
    assertEqual(serializeSf941Dict(parseSf941Dict(actual)), expected, "Content-Digest dictionary must round-trip");
  }
}

async function assertRfc8941DictionaryExamples(): Promise<void> {
  const examples = [
    "en=\"Applepie\", da=:w4ZibGV0w6ZydGU=:",
    "a=?0, b, c;foo=bar, flag;secure",
    "rating=1.5, feelings=(joy sadness)",
    "sig1=(\"@method\" \"@authority\" \"ucp-agent\");keyid=\"platform-2026\""
  ];
  for (const example of examples) {
    assertEqual(serializeSf941Dict(parseSf941Dict(example)), example, `RFC 8941 dictionary did not round-trip: ${example}`);
  }
  await assertRejects(() => parseSf941Dict("a=1, a=2"), "duplicate structured field key");
}

async function assertEcdsaRawSignatureWidths(): Promise<void> {
  const data = Buffer.from("steelyard raw ecdsa width check", "utf8");
  const p256 = await ecdsaSignRaw({ algorithm: "ES256", privateKeyJwk: rfc6979P256.privateJwk, data });
  const p384 = await ecdsaSignRaw({ algorithm: "ES384", privateKeyJwk: rfc6979P384.privateJwk, data });
  assertEqual(p256.byteLength, 64, "ES256 signature must be 64 raw bytes");
  assertEqual(p384.byteLength, 96, "ES384 signature must be 96 raw bytes");
  assert(!looksLikeDerEcdsaSignature(p256), "ES256 signature must not be DER-encoded");
  assert(!looksLikeDerEcdsaSignature(p384), "ES384 signature must not be DER-encoded");
  assert(await ecdsaVerifyRaw({ algorithm: "ES256", publicKeyJwk: rfc6979P256.publicJwk, data, signature: p256 }), "ES256 signature must verify");
  assert(await ecdsaVerifyRaw({ algorithm: "ES384", publicKeyJwk: rfc6979P384.publicJwk, data, signature: p384 }), "ES384 signature must verify");
}

function looksLikeDerEcdsaSignature(value: Uint8Array): boolean {
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 8 || bytes[0] !== 0x30) return false;
  const sequence = readDerLengthPrefix(bytes, 1);
  if (!sequence || sequence.offset + sequence.length !== bytes.byteLength) return false;
  const r = readDerIntegerPrefix(bytes, sequence.offset);
  if (!r) return false;
  const s = readDerIntegerPrefix(bytes, r.offset);
  return Boolean(s && s.offset === bytes.byteLength);
}

function readDerIntegerPrefix(bytes: Buffer, offset: number): { offset: number } | undefined {
  if (bytes[offset] !== 0x02) return undefined;
  const length = readDerLengthPrefix(bytes, offset + 1);
  if (!length) return undefined;
  const end = length.offset + length.length;
  if (length.length === 0 || end > bytes.byteLength) return undefined;
  return { offset: end };
}

function readDerLengthPrefix(bytes: Buffer, offset: number): { length: number; offset: number } | undefined {
  const first = bytes[offset];
  if (first === undefined) return undefined;
  if ((first & 0x80) === 0) return { length: first, offset: offset + 1 };
  const size = first & 0x7f;
  if (size === 0 || size > 4 || offset + size >= bytes.byteLength) return undefined;
  let length = 0;
  for (let index = 0; index < size; index += 1) {
    const next = bytes[offset + 1 + index];
    if (next === undefined) return undefined;
    length = (length << 8) | next;
  }
  return { length, offset: offset + 1 + size };
}

async function assertProfileFetchRejectionModes(): Promise<void> {
  const lookup = async () => [{ address: "203.0.113.10" }] as const;
  await assertRejectsProfileCode(
    fetchUcpProfile("http://profiles.example/.well-known/ucp", {
      fetch: async () => {
        throw new Error("HTTP scheme rejection should happen before fetch");
      }
    }),
    "Ucp.ProfileScheme"
  );
  await assertRejectsProfileCode(
    fetchUcpProfile("https://profiles.example/.well-known/ucp", {
      lookup,
      fetch: async () => new Response("", { status: 302, headers: { location: "https://other.example/.well-known/ucp" } })
    }),
    "Ucp.ProfileRedirect"
  );
  await assertRejectsProfileCode(
    fetchUcpProfile("https://profiles.example/.well-known/ucp", {
      lookup,
      maxBytes: 8,
      fetch: async () => new Response("{\"oversize\":true}", { status: 200 })
    }),
    "Ucp.ProfileTooLarge"
  );
  await assertRejectsProfileCode(
    fetchUcpProfile("https://profiles.example/.well-known/ucp", {
      lookup,
      timeoutMs: 1,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    }),
    "Ucp.ProfileTimeout"
  );
}

async function assertMigrationDocs(ctx: VerifyContext): Promise<void> {
  const migration = await readRepoFile(ctx, "docs/guides/migrating-from-v0.2.md");
  const readme = await readRepoFile(ctx, "README.md");
  assertIncludes(migration, "PurchaseIntent.amount", "migration guide must describe amount semantics");
  assertIncludes(migration, "spendInWindow()", "migration guide must describe spendInWindow()");
  assertIncludes(migration, "listSpend()", "migration guide must describe listSpend()");
  assertIncludes(migration, "wallet.purchase()", "migration guide must describe wallet.purchase()");
  assertIncludes(migration, "createBrowserManualSession", "migration guide must describe browser-manual sessions");
  assertIncludes(readme, "const intent", "README must include inline intent example");
}

async function assertV07PaymentAdapterDocs(ctx: VerifyContext): Promise<void> {
  const changelog = await readRepoFile(ctx, "CHANGELOG.md");
  const releases = await readRepoFile(ctx, "docs/releases.md");
  const adapters = await readRepoFile(ctx, "docs/concepts/payment-adapters.md");
  const readme = await readRepoFile(ctx, "README.md");
  const nav = await readRepoFile(ctx, "mkdocs.yml");
  assertIncludes(changelog, "## [0.7.0] - 2026-06-26", "CHANGELOG must include v0.7.0");
  assertIncludes(releases, "## 0.7.0 - 2026-06-26", "release history must include v0.7.0");
  assertIncludes(adapters, "UCP payment negotiation", "payment-adapters doc must describe UCP negotiation");
  assertIncludes(adapters, "referencePsp()", "payment-adapters doc must describe referencePsp()");
  assertIncludes(adapters, "ACP checkout is intentionally narrower", "payment-adapters doc must describe ACP boundary");
  assertIncludes(readme, "Agent-Native Payments", "README must describe agent-native payment adapter scope");
  assertIncludes(readme, "intentionally direct Stripe SPT-only", "README must describe ACP Stripe-only boundary");
  assertIncludes(nav, "concepts/payment-adapters.md", "MkDocs nav must expose payment-adapters doc");
}

async function assertNoDirectTotalsTotal(ctx: VerifyContext): Promise<void> {
  const files = await listSourceFiles(ctx, [
    "packages/buyer/src/client",
    "packages/protocol/src/acp",
    "packages/protocol/src/ucp"
  ]);
  await assertNoRegexHits(ctx, files, /(?:^|[^\w])totals\s*(?:\.|\[\s*["'])total/g, "direct totals.total access");
}

async function assertNoSourceSystemTime(ctx: VerifyContext): Promise<void> {
  const files = await listSourceFiles(ctx, [
    "packages/buyer/src",
    "packages/merchant/src",
    "packages/protocol/src",
    "packages/core/src"
  ], { excludeTests: true });
  await assertNoRegexHits(ctx, files, /Date\.now\s*\(|new Date\s*\(\s*\)/g, "source system clock call");
}

async function assertMockPspGuard(ctx: VerifyContext): Promise<void> {
  const source = await readRepoFile(ctx, "packages/merchant/src/psp/adapters.ts");
  assertIncludes(source, "STEELYARD_ALLOW_MOCK_PSP", "mockPsp must require STEELYARD_ALLOW_MOCK_PSP");
  assertIncludes(source, "allowInProduction", "mockPsp must require allowInProduction");
  assertIncludes(source, "VITEST", "mockPsp must allow known test environments");
  assertIncludes(source, "MockInProductionError", "mockPsp must throw a production guard error");
}

async function assertMockMandateGuard(ctx: VerifyContext): Promise<void> {
  const source = await readRepoFile(ctx, "packages/merchant/src/mandate/verifier.ts");
  assertIncludes(source, "STEELYARD_ALLOW_MOCK_MANDATE", "mockMandateVerifier must require STEELYARD_ALLOW_MOCK_MANDATE");
  assertIncludes(source, "allowInProduction", "mockMandateVerifier must require allowInProduction");
  assertIncludes(source, "VITEST", "mockMandateVerifier must allow known test environments");
  assertIncludes(source, "MockMandateInProductionError", "mockMandateVerifier must throw a production guard error");
}

async function assertNoMerchantDelegateRoute(ctx: VerifyContext): Promise<void> {
  const source = await readRepoFile(ctx, "packages/merchant/src/checkout/server.ts");
  if (/agentic_commerce\/delegate_payment/.test(source)) {
    throw new Error("merchant checkout server contains a delegate_payment route");
  }
  assertExists(ctx, "examples/coffee-shop/scripts/scan-routes.ts");
}

async function assertWorkflowContains(ctx: VerifyContext, needle: string): Promise<void> {
  const workflow = await readRepoFile(ctx, ".github/workflows/ci.yml");
  assertIncludes(workflow, needle, `.github/workflows/ci.yml must include ${needle}`);
}

async function assertLinuxKeychainWorkflow(ctx: VerifyContext): Promise<void> {
  const workflow = await readRepoFile(ctx, ".github/workflows/ci.yml");
  assertIncludes(workflow, "dbus-launch", "Linux keychain lane must launch dbus");
  assertIncludes(workflow, "STEELYARD_TEST_KEYSTORE=keychain pnpm test", "Linux keychain tests must run in dbus shell");
}

async function assertAcpSpecVendored(ctx: VerifyContext): Promise<void> {
  assertFilesExist(ctx, "packages/protocol/spec/acp/2026-04-17/json-schema", [
    "schema.feed.json",
    "schema.agentic_checkout.json",
    "schema.delegate_payment.json",
    "schema.cart.json"
  ]);
}

async function assertUcpSpecVendored(ctx: VerifyContext): Promise<void> {
  assertFilesExist(ctx, "packages/protocol/spec/ucp/2026-04-17/schemas/shopping", [
    "checkout.json",
    "cart.json",
    "payment.json",
    "order.json",
    "ap2_mandate.json",
    "buyer_consent.json",
    "discount.json",
    "fulfillment.json",
    "split_payments.json",
    "types/order_confirmation.json",
    "types/payment_instrument.json",
    "types/payment_credential.json"
  ]);
}

async function assertProtocolDistSpecs(ctx: VerifyContext): Promise<void> {
  assertFilesExist(ctx, "packages/protocol/dist/spec/acp/2026-04-17/json-schema", [
    "schema.feed.json",
    "schema.agentic_checkout.json",
    "schema.delegate_payment.json",
    "schema.cart.json"
  ]);
  assertFilesExist(ctx, "packages/protocol/dist/spec/ucp/2026-04-17/schemas/shopping", [
    "checkout.json",
    "cart.json",
    "payment.json",
    "order.json",
    "types/order_confirmation.json"
  ]);
}

async function assertPackageExports(ctx: VerifyContext, file: string, exports: string[]): Promise<void> {
  const pkg = await readJsonFile(ctx, file) as { exports?: Record<string, unknown> };
  for (const key of exports) {
    if (!pkg.exports || !(key in pkg.exports)) throw new Error(`${file} is missing export ${key}`);
  }
}

async function assertMerchantScriptsReal(ctx: VerifyContext): Promise<void> {
  const pkg = await readJsonFile(ctx, "packages/merchant/package.json") as { scripts?: Record<string, string> };
  for (const script of ["build", "test", "typecheck"]) {
    const value = pkg.scripts?.[script];
    if (!value) throw new Error(`packages/merchant/package.json is missing ${script}`);
    if (/\becho\b|exit\s+0/.test(value)) throw new Error(`merchant ${script} script is a no-op: ${value}`);
  }
}

async function assertNodeHttpRoutes(ctx: VerifyContext): Promise<void> {
  const source = await readRepoFile(ctx, "packages/merchant/src/checkout/server.ts");
  assertIncludes(source, "IncomingMessage", "checkout routes must use IncomingMessage");
  assertIncludes(source, "ServerResponse", "checkout routes must use ServerResponse");
  assertIncludes(source, "RequestListener", "checkout handler must expose RequestListener");
}

async function assertWalletFacadeClosed(ctx: VerifyContext): Promise<void> {
  const source = await readRepoFile(ctx, "packages/buyer/src/wallet/index.ts");
  const forbidden = [
    /(^|\n)\s*(?:public\s+|readonly\s+)(?:vault|policy|mandate|payment)\b/,
    /(^|\n)\s*get\s+(?:vault|policy|mandate|payment)\s*\(/,
    /(^|\n)\s*set\s+(?:vault|policy|mandate|payment)\s*\(/
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error("Wallet exposes a forbidden public escape hatch");
  }
}

async function assertProtocolBoundary(ctx: VerifyContext, file: string): Promise<void> {
  const source = await readRepoFile(ctx, file);
  if (/from\s+["']@steelyard\/merchant/.test(source)) throw new Error(`${file} imports merchant code`);
  if (/from\s+["']node:fs|from\s+["']fs/.test(source)) throw new Error(`${file} imports filesystem code`);
}

async function runAudit(ctx: VerifyContext): Promise<VerifyResult[]> {
  const started = performance.now();
  const results: VerifyResult[] = [];
  const testIds = new Set(buildCases().map((test) => test.id));
  for (const finding of REQUIRED_FINDINGS) {
    const coveredBy = FINDING_COVERAGE[finding] ?? [];
    const missingIds = coveredBy.filter((id) => !id.startsWith("docs:") && !testIds.has(id));
    const passed = coveredBy.length > 0 && missingIds.length === 0;
    results.push({
      id: `audit:${finding}`,
      suite: "VR-Audit",
      title: `${finding} coverage mapping`,
      verifies: [finding],
      status: passed ? "passed" : "failed",
      evidence: coveredBy,
      duration_ms: Math.round(performance.now() - started),
      ...(passed ? {} : { error: missingIds.length ? `missing test IDs: ${missingIds.join(", ")}` : "no coverage mapping" })
    });
  }
  return results;
}

function selectCases(cases: VerifyCase[], args: VerifyArgs): VerifyCase[] {
  if (args.audit && !args.checkClocks && !args.checkMockGuards && args.suites.length === 0) return [];
  let selected = cases;
  if (args.suites.length > 0) {
    const wanted = new Set(args.suites.map((suite) => suite.toLowerCase()));
    selected = selected.filter((test) => wanted.has(test.suite.toLowerCase()) || wanted.has(test.id.toLowerCase()));
  }
  if (args.checkClocks) selected = selected.filter((test) => test.id === "VH-05");
  if (args.checkMockGuards) selected = selected.filter((test) => ["VSec-03", "VSec-04", "VSec-05", "VSec-06"].includes(test.id));
  return selected;
}

function shouldRunDefaultAudit(args: VerifyArgs): boolean {
  return !args.checkClocks && !args.checkMockGuards && args.suites.length === 0 && !args.audit;
}

function resultFor(test: VerifyCase, status: VerifyStatus, started: number, error?: unknown): VerifyResult {
  return {
    id: test.id,
    suite: test.suite,
    title: test.title,
    verifies: test.verifies,
    status,
    evidence: test.evidence,
    duration_ms: Math.round(performance.now() - started),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
  };
}

function buildReport(args: VerifyArgs, results: VerifyResult[]): VerifyReport {
  const summary = {
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    total: results.length
  };
  return {
    generated_at: new Date(globalThis.performance.timeOrigin + globalThis.performance.now()).toISOString(),
    ...(args.lane ? { lane: args.lane } : {}),
    filters: {
      suites: args.suites,
      audit: args.audit,
      check_clocks: args.checkClocks,
      check_mock_guards: args.checkMockGuards
    },
    summary,
    results
  };
}

async function writeReport(ctx: VerifyContext, report: VerifyReport): Promise<void> {
  const output = join(ctx.repoRoot, "verify-report.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function printSummary(report: VerifyReport): void {
  for (const result of report.results) {
    const marker = result.status === "passed" ? "PASS" : result.status === "skipped" ? "SKIP" : "FAIL";
    const suffix = result.error ? ` — ${result.error}` : "";
    console.log(`${marker} ${result.id} ${result.title}${suffix}`);
  }
  console.log(
    `verify: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped, ${report.summary.total} total`
  );
  console.log("verify: wrote verify-report.json");
}

async function runCommandOnce(
  ctx: VerifyContext,
  key: string,
  command: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<void> {
  const existing = ctx.commandCache.get(key);
  if (existing) return existing;
  const promise = runCommand(ctx, command, args, env);
  ctx.commandCache.set(key, promise);
  return promise;
}

async function runCommand(ctx: VerifyContext, command: string, args: string[], env: Record<string, string>): Promise<void> {
  const output: string[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ctx.repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${tail(output.join(""), 120)}`));
    });
  });
}

async function listSourceFiles(
  ctx: VerifyContext,
  dirs: string[],
  opts: { excludeTests?: boolean } = {}
): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    files.push(...await listFiles(resolve(ctx.repoRoot, dir), opts));
  }
  return files;
}

async function listFiles(root: string, opts: { excludeTests?: boolean }): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (["dist", "coverage", "node_modules"].includes(entry.name)) continue;
      files.push(...await listFiles(path, opts));
      continue;
    }
    if (!entry.isFile() || !path.endsWith(".ts")) continue;
    if (opts.excludeTests && path.endsWith(".test.ts")) continue;
    files.push(path);
  }
  return files;
}

async function assertNoRegexHits(
  ctx: VerifyContext,
  files: string[],
  pattern: RegExp,
  label: string
): Promise<void> {
  const hits: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    pattern.lastIndex = 0;
    if (!pattern.test(source)) continue;
    hits.push(relative(ctx.repoRoot, file));
  }
  if (hits.length > 0) throw new Error(`${label} found in ${hits.join(", ")}`);
}

function assertFilesExist(ctx: VerifyContext, root: string, files: string[]): void {
  for (const file of files) assertExists(ctx, join(root, file));
}

function assertExists(ctx: VerifyContext, path: string): void {
  if (!existsSync(resolve(ctx.repoRoot, path))) throw new Error(`missing ${path}`);
}

async function readRepoFile(ctx: VerifyContext, path: string): Promise<string> {
  return await readFile(resolve(ctx.repoRoot, path), "utf8");
}

async function readJsonFile(ctx: VerifyContext, path: string): Promise<unknown> {
  return JSON.parse(await readRepoFile(ctx, path));
}

function assertIncludes(source: string, needle: string, message: string): void {
  if (!source.includes(needle)) throw new Error(message);
}

function assert(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function assertRejects(fn: () => unknown, messagePattern: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(messagePattern)) return;
    throw new Error(`expected rejection including ${messagePattern}, got ${message}`);
  }
  throw new Error(`expected rejection including ${messagePattern}`);
}

async function assertRejectsProfileCode(promise: Promise<unknown>, code: UcpProfileFetchErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === code) return;
    const actual = typeof error === "object" && error !== null && "code" in error ? String(error.code) : error instanceof Error ? error.message : String(error);
    throw new Error(`expected ${code}, got ${actual}`);
  }
  throw new Error(`expected ${code}`);
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function parseArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = {
    suites: [],
    audit: false,
    checkClocks: false,
    checkMockGuards: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--audit") {
      args.audit = true;
    } else if (arg === "--check-clocks") {
      args.checkClocks = true;
    } else if (arg === "--check-mock-guards") {
      args.checkMockGuards = true;
    } else if (arg === "--suite") {
      const value = argv[index + 1];
      if (!value) throw new Error("--suite requires a value");
      args.suites.push(value);
      index += 1;
    } else if (arg === "--lane") {
      const value = argv[index + 1];
      if (!value) throw new Error("--lane requires a value");
      args.lane = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown verify argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm verify [--suite <name>] [--lane <lane>] [--audit] [--check-clocks] [--check-mock-guards]

Runs the Steelyard verification harness and writes verify-report.json.`);
}

function range(prefix: string, start: number, end: number): string[] {
  const values: string[] = [];
  for (let value = start; value <= end; value += 1) {
    values.push(`${prefix}${String(value).padStart(2, "0")}`);
  }
  return values;
}

function findingRange(prefix: string, start: number, end: number): string[] {
  const values: string[] = [];
  for (let value = start; value <= end; value += 1) {
    values.push(`${prefix}${value}`);
  }
  return values;
}

function invertCoverage(coverage: Record<string, string[]>): Record<string, string[]> {
  const inverse: Record<string, string[]> = {};
  for (const [finding, ids] of Object.entries(coverage)) {
    for (const id of ids) {
      inverse[id] = [...(inverse[id] ?? []), finding];
    }
  }
  return inverse;
}

function tail(value: string, lines: number): string {
  return value.split(/\r?\n/).slice(-lines).join("\n");
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const rfc9421P256 = {
  publicJwk: {
    kid: "test-key-ecc-p256",
    kty: "EC",
    crv: "P-256",
    x: "qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA",
    y: "Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0",
    use: "sig",
    alg: "ES256"
  },
  privateJwk: {
    kid: "test-key-ecc-p256",
    kty: "EC",
    crv: "P-256",
    d: "UpuF81l-kOxbjf7T4mNSv0r5tN67Gim7rnf6EFpcYDs",
    x: "qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA",
    y: "Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0",
    use: "sig",
    alg: "ES256"
  }
} satisfies { publicJwk: EcJwk; privateJwk: EcJwk };

const rfc6979P256 = {
  publicJwk: {
    kid: "p256",
    kty: "EC",
    crv: "P-256",
    x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
    y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
    use: "sig",
    alg: "ES256"
  },
  privateJwk: {
    kid: "p256",
    kty: "EC",
    crv: "P-256",
    x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
    y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
    d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721"),
    use: "sig",
    alg: "ES256"
  }
} satisfies { publicJwk: EcJwk; privateJwk: EcJwk };

const rfc6979P384 = {
  publicJwk: {
    kid: "p384",
    kty: "EC",
    crv: "P-384",
    x: b64urlHex(
      "EC3A4E415B4E19A4568618029F427FA5DA9A8BC4AE92E02E06AAE5286B300C64" +
        "DEF8F0EA9055866064A254515480BC13"
    ),
    y: b64urlHex(
      "8015D9B72D7D57244EA8EF9AC0C621896708A59367F9DFB9F54CA84B3F1C9DB1" +
        "288B231C3AE0D4FE7344FD2533264720"
    ),
    use: "sig",
    alg: "ES384"
  },
  privateJwk: {
    kid: "p384",
    kty: "EC",
    crv: "P-384",
    x: b64urlHex(
      "EC3A4E415B4E19A4568618029F427FA5DA9A8BC4AE92E02E06AAE5286B300C64" +
        "DEF8F0EA9055866064A254515480BC13"
    ),
    y: b64urlHex(
      "8015D9B72D7D57244EA8EF9AC0C621896708A59367F9DFB9F54CA84B3F1C9DB1" +
        "288B231C3AE0D4FE7344FD2533264720"
    ),
    d: b64urlHex("6B9D3DAD2E1B8C1C05B19875B6659F4DE23C3B667BF297BA9AA47740787137D8" + "96D5724E4C70A825F872C9EA60D2EDF5"),
    use: "sig",
    alg: "ES384"
  }
} satisfies { publicJwk: EcJwk; privateJwk: EcJwk };

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
