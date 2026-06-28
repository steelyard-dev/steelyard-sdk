import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { Engine, InMemoryFxQuoteService, verifyChain } from "@steelyard/policy";
import { CardRailAdapter } from "../src/adapter.js";
import { WebhookEventBus, type StripeIssuingEvent } from "../src/observe.js";

const POLICY = `
version: 2026-06-27
trusted_domains: { tier1: [stripe.test] }
rules:
  - name: ok
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 100 } }
  - name: deny-all
    do: deny
`;

describe("Stripe Issuing replay fixture", () => {
  it("proposes, mints, observes a captured event, and amends the audit log", async () => {
    const bus = new WebhookEventBus();
    const stripe = {
      issuing: {
        cards: {
          create: vi.fn(async () => ({
            id: "ic_fixture",
            number: "4242424242424242",
            cvc: "123",
            exp_month: 12,
            exp_year: 2026
          })),
          update: vi.fn(async () => ({ id: "ic_fixture" }))
        }
      }
    };
    const adapter = new CardRailAdapter({
      stripe: stripe as unknown as ConstructorParameters<typeof CardRailAdapter>[0]["stripe"],
      cardholderId: "ich_fixture",
      env: "sandbox",
      webhookBus: bus
    });
    const dataDir = mkdtempSync(join(tmpdir(), "e2e-replay-"));
    const clock = { now: () => new Date("2026-06-28T12:00:00.000Z") };
    const engine = new Engine({
      dataDir,
      clock,
      fx: new InMemoryFxQuoteService({}, clock.now),
      rails: [adapter],
      policyYaml: POLICY
    });
    await engine.start();

    const result = await engine.proposeIntent({
      caller_token: engine.callerToken(),
      idempotency_key: "replay-1",
      intent: { merchant: { domain: "stripe.test" }, amount: { amount_minor: 5000n, currency: "USD" }, type: "one_time" }
    });
    expect(result.decision).toBe("allow");
    if (result.decision !== "allow") throw new Error("expected allow");

    bus.ingest({
      id: "evt_capture_fixture",
      type: "issuing_transaction.created",
      created: 1782657605,
      data: { object: { card: "ic_fixture", amount: 5000, currency: "usd" } }
    });
    await engine.ackSettlement({
      caller_token: engine.callerToken(),
      credential_id: result.credential.credential_id,
      event_id: "evt_capture_fixture"
    });
    await engine.stop();

    const audit = readFileSync(join(dataDir, "audit", "2026-06-28.jsonl"), "utf8");
    expect(audit).toContain('"settlement_events"');
    expect(audit).toContain('"evt_capture_fixture"');
    await expect(verifyChain(join(dataDir, "audit"))).resolves.toEqual({ ok: true, breaks: [] });
  });
});

const KEY = process.env.STRIPE_ISSUING_TEST_KEY;
const CARDHOLDER = process.env.STRIPE_ISSUING_TEST_CARDHOLDER;

(KEY && CARDHOLDER ? describe : describe.skip)("Stripe Issuing sandbox e2e", () => {
  it("mints a virtual card, captures a test authorization, and records settlement in the audit log", async () => {
    expect(KEY).toMatch(/^sk_test_/);
    const stripe = new Stripe(KEY!);
    const bus = new WebhookEventBus();
    const adapter = new CardRailAdapter({ stripe, cardholderId: CARDHOLDER!, env: "sandbox", webhookBus: bus });
    const dataDir = mkdtempSync(join(tmpdir(), "e2e-sandbox-"));
    const clock = { now: () => new Date() };
    const engine = new Engine({
      dataDir,
      clock,
      fx: new InMemoryFxQuoteService({}, clock.now),
      rails: [adapter],
      policyYaml: POLICY
    });
    await engine.start();

    try {
      const result = await engine.proposeIntent({
        caller_token: engine.callerToken(),
        idempotency_key: `sandbox-${Date.now()}`,
        intent: { merchant: { domain: "stripe.test" }, amount: { amount_minor: 5000n, currency: "USD" }, type: "one_time" }
      });

      expect(result.decision).toBe("allow");
      if (result.decision !== "allow") throw new Error("expected allow");
      expect((result.credential.payload as { raw?: { id?: string } }).raw?.id).toMatch(/^ic_/);
      const cardId = (result.credential.payload as { raw?: { id?: string } }).raw?.id;
      if (!cardId) throw new Error("Stripe card id missing from issued credential payload");

      const authorization = await stripe.testHelpers.issuing.authorizations.create({
        card: cardId,
        amount: 5000,
        currency: "usd",
        merchant_amount: 5000,
        merchant_currency: "usd"
      });
      bus.ingest(authorizationEvent(authorization));

      const captured = await stripe.testHelpers.issuing.authorizations.capture(authorization.id, { capture_amount: 5000 });
      const transaction = captured.transactions.at(-1);
      if (!transaction) throw new Error(`Stripe capture ${captured.id} did not return an issuing transaction`);
      const captureEvent = transactionEvent(transaction);
      bus.ingest(captureEvent);

      await engine.ackSettlement({
        caller_token: engine.callerToken(),
        credential_id: result.credential.credential_id,
        event_id: captureEvent.id
      });

      const auditPath = join(dataDir, "audit", new Date().toISOString().slice(0, 10) + ".jsonl");
      const audit = readFileSync(auditPath, "utf8");
      expect(audit).toContain('"settlement_events"');
      expect(audit).toContain(captureEvent.id);
      await expect(verifyChain(join(dataDir, "audit"))).resolves.toEqual({ ok: true, breaks: [] });
    } finally {
      await engine.stop();
    }
  }, 30_000);
});

function authorizationEvent(authorization: Stripe.Issuing.Authorization): StripeIssuingEvent {
  return {
    id: `evt_${authorization.id}`,
    type: "issuing_authorization.created",
    created: authorization.created,
    data: {
      object: {
        card: cardId(authorization.card),
        amount: authorization.amount,
        currency: authorization.currency,
        approved: authorization.approved
      }
    }
  };
}

function transactionEvent(transaction: Stripe.Issuing.Transaction): StripeIssuingEvent {
  return {
    id: `evt_${transaction.id}`,
    type: "issuing_transaction.created",
    created: transaction.created,
    data: {
      object: {
        card: cardId(transaction.card),
        amount: transaction.amount,
        currency: transaction.currency
      }
    }
  };
}

function cardId(card: string | { id?: string }): string {
  if (typeof card === "string") return card;
  if (card.id) return card.id;
  throw new Error("Stripe event object did not include a card id");
}
