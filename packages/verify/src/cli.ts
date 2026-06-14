#!/usr/bin/env node
// Copyright (c) Steelyard contributors. MIT License.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  cases.push({
    id: "docs:migration",
    suite: "docs",
    title: "Migration guide covers v0.3 behavioral changes",
    verifies: ["F40"],
    evidence: ["docs/guides/migrating-from-v0.2.md", "README.md"],
    run: assertMigrationDocs
  });
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
    ["VCI-11", "CI scans coffee-shop routes for delegate_payment", allLanes, (ctx) => assertWorkflowContains(ctx, "scan:routes")]
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

async function assertMigrationDocs(ctx: VerifyContext): Promise<void> {
  const migration = await readRepoFile(ctx, "docs/guides/migrating-from-v0.2.md");
  const readme = await readRepoFile(ctx, "README.md");
  assertIncludes(migration, "PurchaseIntent.amount", "migration guide must describe amount semantics");
  assertIncludes(migration, "spendInWindow()", "migration guide must describe spendInWindow()");
  assertIncludes(migration, "listSpend()", "migration guide must describe listSpend()");
  assertIncludes(migration, "Wallet.pay()", "migration guide must describe Wallet.pay()");
  assertIncludes(readme, "const intent", "README must include inline intent example");
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

Runs the Steelyard v0.3 verification harness and writes verify-report.json.`);
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
