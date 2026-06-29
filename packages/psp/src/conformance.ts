// Copyright (c) Steelyard contributors. MIT License.
import type {
  PaymentMandateIssuer,
  PaymentMandate,
  PaymentMandateRequest
} from "@steelyard-dev/core";
import type { PspAdapter, PspCaptureArgs } from "./index.js";

export type ConformanceCaseStatus = "passed" | "failed";

export interface ConformanceCase {
  id: string;
  title: string;
  status: ConformanceCaseStatus;
  error?: string;
}

export interface ConformanceReport {
  passed: number;
  failed: number;
  cases: ConformanceCase[];
}

export interface PspFailureFixture {
  id: string;
  title?: string;
  args: PspCaptureArgs;
  expectedReason?: string;
}

export interface PspConformanceOptions {
  success: PspCaptureArgs;
  unsupportedHandlerId?: string;
  mismatch?: PspCaptureArgs;
  failures?: readonly PspFailureFixture[];
}

export interface MandateIssuerConformanceOptions {
  draft: PaymentMandateRequest;
  incompleteDraft?: PaymentMandateRequest;
}

type CaseBody = () => Promise<void> | void;

export async function runPspConformance(adapter: PspAdapter, opts: PspConformanceOptions): Promise<ConformanceReport> {
  const cases: ConformanceCase[] = [];
  await record(cases, "psp.capabilities", "capability declaration is well-formed", () => assertCapabilities(adapter));
  await record(cases, "psp.supportsHandler", "supportsHandler matches declared capabilities", () => {
    for (const capability of adapter.capabilities) {
      assert(adapter.supportsHandler(capability.handlerId), `expected supportsHandler(${capability.handlerId})`);
    }
    if (opts.unsupportedHandlerId) {
      assert(!adapter.supportsHandler(opts.unsupportedHandlerId), `unexpected support for ${opts.unsupportedHandlerId}`);
    }
  });
  await record(cases, "psp.capture.success", "capture returns a valid successful result", async () => {
    const result = await adapter.capture(opts.success);
    assertCaptureSuccess(result);
  });
  await record(cases, "psp.capture.idempotency", "capture is idempotent for the same idempotency key", async () => {
    const first = await adapter.capture(opts.success);
    const second = await adapter.capture({ ...opts.success });
    assertDeepEqual(second, first, "idempotent capture result changed");
  });
  await record(cases, "psp.cancel.idempotency", "cancel accepts repeated cancellation with one idempotency key", async () => {
    const captured = await adapter.capture(opts.success);
    const paymentId = captured.ok ? captured.psp_payment_id : "psp_conformance_cancel_probe";
    await adapter.cancel({ psp_payment_id: paymentId, idempotencyKey: `${opts.success.idempotencyKey}:cancel` });
    await adapter.cancel({ psp_payment_id: paymentId, idempotencyKey: `${opts.success.idempotencyKey}:cancel` });
  });
  if (opts.mismatch) {
    await record(cases, "psp.capture.mismatch", "mandate or instrument mismatch is rejected", async () => {
      await assertRejectedCapture(adapter, opts.mismatch!);
    });
  }
  for (const failure of opts.failures ?? []) {
    await record(cases, `psp.capture.failure.${failure.id}`, failure.title ?? `capture rejects ${failure.id}`, async () => {
      const result = await adapter.capture(failure.args);
      assertCaptureFailure(result, failure.expectedReason);
    });
  }
  return report(cases);
}

export async function runMandateIssuerConformance(
  issuer: PaymentMandateIssuer,
  opts: MandateIssuerConformanceOptions
): Promise<ConformanceReport> {
  const cases: ConformanceCase[] = [];
  await record(cases, "issuer.instrumentType", "instrumentType is declared", () => {
    assert(typeof issuer.instrumentType === "string" && issuer.instrumentType.length > 0, "instrumentType is required");
  });
  await record(cases, "issuer.issueMandate.scope", "issueMandate scopes to the draft", async () => {
    const handle = await issuer.issueMandate(opts.draft);
    assertPaymentMandate(handle);
    assert(handle.currency.toUpperCase() === opts.draft.payment.currency, "currency widened or changed");
    assert(handle.max_amount <= opts.draft.payment.amount, "max_amount widens draft amount");
    const draftExpiry = unixSeconds(opts.draft.payment.expires_at);
    assert(Number.isSafeInteger(draftExpiry), "draft expiry must parse as unix seconds");
    assert(handle.expires_at <= draftExpiry, "expires_at widens draft expiry");
  });
  await record(cases, "issuer.issueMandate.incomplete", "issueMandate refuses incomplete scope", async () => {
    await assertRejectedMandateIssuer(
      issuer,
      opts.incompleteDraft ?? ({
        iat: opts.draft.iat,
        nonce: opts.draft.nonce,
        payment: {
          amount: opts.draft.payment.amount,
          currency: "",
          checkout_id: opts.draft.payment.checkout_id,
          expires_at: opts.draft.payment.expires_at
        }
      } as PaymentMandateRequest)
    );
  });
  return report(cases);
}

async function record(cases: ConformanceCase[], id: string, title: string, body: CaseBody): Promise<void> {
  try {
    await body();
    cases.push({ id, title, status: "passed" });
  } catch (error) {
    cases.push({ id, title, status: "failed", error: errorMessage(error) });
  }
}

function report(cases: ConformanceCase[]): ConformanceReport {
  return {
    passed: cases.filter((test) => test.status === "passed").length,
    failed: cases.filter((test) => test.status === "failed").length,
    cases
  };
}

function assertCapabilities(adapter: PspAdapter): void {
  assert(typeof adapter.name === "string" && adapter.name.length > 0, "adapter.name is required");
  const capabilities = adapter.capabilities;
  assert(Array.isArray(capabilities), "adapter.capabilities must be an array");
  assert(capabilities.length > 0, "adapter.capabilities must not be empty");
  const seen = new Set<string>();
  for (const [index, capability] of capabilities.entries()) {
    assert(typeof capability.handlerId === "string" && capability.handlerId.length > 0, `capability ${index} missing handlerId`);
    assert(
      typeof capability.instrumentType === "string" && capability.instrumentType.length > 0,
      `capability ${index} missing instrumentType`
    );
    if (capability.idPrefix !== undefined) {
      assert(typeof capability.idPrefix === "string" && capability.idPrefix.length > 0, `capability ${index} has empty idPrefix`);
    }
    const key = `${capability.handlerId}\0${capability.instrumentType}`;
    assert(!seen.has(key), `duplicate capability ${capability.handlerId}/${capability.instrumentType}`);
    seen.add(key);
  }
}

function assertCaptureSuccess(result: Awaited<ReturnType<PspAdapter["capture"]>>): void {
  assert(result && typeof result === "object", "capture result must be an object");
  assert(result.ok === true, `expected successful capture, received ${JSON.stringify(result)}`);
  assert(typeof result.psp_payment_id === "string" && result.psp_payment_id.length > 0, "psp_payment_id is required");
  assert(result.status === "captured" || result.status === "authorized", "status must be captured or authorized");
}

function assertCaptureFailure(result: Awaited<ReturnType<PspAdapter["capture"]>>, expectedReason: string | undefined): void {
  assert(result && typeof result === "object", "capture result must be an object");
  assert(result.ok === false, `expected failed capture, received ${JSON.stringify(result)}`);
  if ("requires_authentication" in result) {
    assert(typeof result.continue_url === "string" && result.continue_url.length > 0, "continue_url is required");
    return;
  }
  assert(typeof result.reason === "string" && result.reason.length > 0, "failure reason is required");
  assert(typeof result.message === "string" && result.message.length > 0, "failure message is required");
  if (expectedReason) assert(result.reason === expectedReason || result.detail === expectedReason, `expected ${expectedReason}`);
}

async function assertRejectedCapture(adapter: PspAdapter, args: PspCaptureArgs): Promise<void> {
  try {
    const result = await adapter.capture(args);
    assertCaptureFailure(result, undefined);
  } catch {
    return;
  }
}

function assertPaymentMandate(handle: PaymentMandate): void {
  assert(handle && typeof handle === "object", "payment mandate must be an object");
  assert(typeof handle.id === "string" && handle.id.length > 0, "payment mandate id is required");
  assert(Number.isSafeInteger(handle.expires_at), "payment mandate expires_at must be an integer");
  assert(Number.isSafeInteger(handle.max_amount) && handle.max_amount >= 0, "payment mandate max_amount must be non-negative");
  assert(/^[A-Z]{3}$/.test(handle.currency), "payment mandate currency must be ISO 4217 uppercase");
  assert(handle.scope_proof && typeof handle.scope_proof === "object", "payment mandate scope_proof is required");
  assert(typeof handle.scope_proof.type === "string" && handle.scope_proof.type.length > 0, "scope_proof.type is required");
}

async function assertRejectedMandateIssuer(issuer: PaymentMandateIssuer, draft: PaymentMandateRequest): Promise<void> {
  try {
    const handle = await issuer.issueMandate(draft);
    throw new Error(`expected issueMandate to reject, received ${JSON.stringify(handle)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("expected issueMandate")) throw error;
  }
}

function unixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : Math.floor(parsed / 1000);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
