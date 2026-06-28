import type { PurchaseIntent, Receipt } from "@steelyard/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Merchant } from "../client/index.js";

const keyringState = vi.hoisted(() => ({
  secrets: new Map<string, Uint8Array>(),
  fail: false
}));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class MockAsyncEntry {
    readonly #key: string;

    constructor(service: string, account: string) {
      this.#key = `${service}\0${account}`;
    }

    async getSecret(): Promise<Uint8Array | undefined> {
      if (keyringState.fail) throw new Error("locked keychain");
      const secret = keyringState.secrets.get(this.#key);
      return secret ? new Uint8Array(secret) : undefined;
    }

    async setSecret(secret: Uint8Array): Promise<void> {
      if (keyringState.fail) throw new Error("locked keychain");
      keyringState.secrets.set(this.#key, new Uint8Array(secret));
    }

    async deleteCredential(): Promise<boolean> {
      keyringState.secrets.delete(this.#key);
      return true;
    }
  }
}));

const walletModule = await import("./index.js");
const {
  Wallet,
  BrowserManualSession,
  WalletApprovalRequired,
  WalletNotAllowed,
  WalletAmountExceeded,
  ReceiptPersistenceFailed,
  NoCardForMerchant,
  KeystoreUnavailable,
  MandateKeyMissing,
  vaultedCard
} = walletModule;

const originalCwd = process.cwd();
const originalHome = process.env.HOME;

const intent: PurchaseIntent = {
  merchant: { domain: "coffee.example", transport_url: "https://coffee.example/mcp", protocol: "mcp" },
  offer: { id: "latte", title: "Latte", categories: ["coffee"] },
  amount: 450,
  currency: "USD",
  intent_id: "intent_coffee"
};

const purchaseClock = new Date();

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-wallet-"));
  try {
    process.chdir(root);
    process.env.HOME = root;
    return await fn(root);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
}

function createOptions(overrides: Partial<Parameters<typeof Wallet.create>[0]> = {}) {
  return {
    project: true,
    card: { number: "4111111111111111", exp: "12/99", name: "Jane Doe" },
    billing: {
      email: "jane@example.com",
      address: { line1: "1 Main St", city: "SF", postal_code: "94110", country: "US" }
    },
    limits: { daily: { USD: 100, JPY: 1000 }, weekly: { USD: 500 }, monthly: { USD: 2000 } },
    allowedMerchants: ["coffee.example"],
    ...overrides
  };
}

function purchaseReceipt(amount = intent.amount): Receipt {
  return {
    intent,
    protocol: "acp",
    order_id: "order_1",
    status: "captured",
    charged_amount: amount,
    charged_currency: "USD",
    created_at: purchaseClock.toISOString(),
    reference: { acp: { checkout_session_id: "cs_1", vault_token_id: "vt_1" } }
  };
}

function merchantWithPurchase(purchase: Merchant["purchase"]): Merchant {
  return {
    id: "coffee.example",
    protocol: "acp",
    url: "https://coffee.example/acp",
    supports: (capability) => capability === "read" || capability === "checkout",
    search: async () => [],
    lookup: async () => ({ error: "not_found" }),
    getOffer: async () => ({ error: "not_found" }),
    getManifest: async () => ({ schemaVersion: "0.1", identity: { name: "Coffee", currencies: [] }, catalog: { offers: [] }, policies: [] }),
    getPolicies: async () => [],
    purchase
  };
}

describe("Wallet setup and open", () => {
  beforeEach(() => {
    keyringState.secrets.clear();
    keyringState.fail = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates project wallet files, converts limits, tags the first card default, and opens round-trip", async () => {
    await withWorkspace(async (root) => {
      const wallet = await Wallet.create(createOptions());
      await expect(wallet.hasMandateKey()).resolves.toBe(true);
      const publicKey = await wallet.exportMandatePublicKey();
      expect(publicKey).toMatchObject({
        key_id: expect.stringMatching(/^mk_/),
        jwk: { kty: "OKP", crv: "Ed25519", x: expect.any(String) }
      });
      expect(publicKey.jwk).not.toHaveProperty("d");
      const vaultRaw = await readFile(join(root, ".steelyard", "vault.box"));
      expect(Buffer.from(vaultRaw).includes(Buffer.from(String(publicKey.jwk.x)))).toBe(false);

      const policyRaw = await readFile(join(root, ".steelyard", "policy.yml"), "utf8");
      const policy = parseDocument(policyRaw).toJSON() as any;
      expect(policy.limits.daily).toMatchObject({ USD: 10000, JPY: 1000 });
      expect(policy.rules[0]).toMatchObject({
        name: "steelyard.wallet.allowed_merchants",
        where: { merchant_domain: ["coffee.example"] }
      });

      const payment = await wallet.createBrowserManualSession(intent);
      expect(payment.metadata).toEqual({ brand: "visa", last4: "1111", exp: "12/99", name: "Jane Doe" });
      expect(JSON.stringify(payment.metadata)).not.toContain("4111111111111111");

      const reopened = await Wallet.open({ project: true });
      await expect(reopened.hasMandateKey()).resolves.toBe(true);
      await expect(reopened.hasUcpSigningKey()).resolves.toBe(true);
      await expect(reopened.exportMandatePublicKey()).resolves.toEqual(publicKey);
      await expect(reopened.exportUcpSigningPublicKey()).resolves.toMatchObject({ alg: "ES256" });
      await expect(reopened.isAllowed(intent)).resolves.toBe(true);
      await expect(reopened.decide({ ...intent, merchant: { ...intent.merchant, domain: "blocked.example" } }))
        .resolves.toEqual({ status: "denied", reason: "default deny" });
    });
  });

  it("can skip the default mandate key and create it later", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions({ mandateKey: false }));

      await expect(wallet.hasMandateKey()).resolves.toBe(false);
      await expect(wallet.hasUcpSigningKey()).resolves.toBe(false);
      await expect(wallet.exportMandatePublicKey()).rejects.toBeInstanceOf(MandateKeyMissing);

      const created = await wallet.createMandateKey();
      expect(created).toMatchObject({ key_id: expect.stringMatching(/^mk_/), algorithm: "Ed25519" });
      await expect(wallet.hasMandateKey()).resolves.toBe(true);
      await expect(wallet.exportMandatePublicKey()).resolves.toMatchObject({ key_id: created.key_id });
      await expect(wallet.ensureUcpSigningKey()).resolves.toMatchObject({ kid: expect.any(String) });
      await expect(wallet.ensureUcpSigningKey()).resolves.toMatchObject({ kid: expect.any(String) });
    });
  });

  it("overwrites existing project wallet files when requested", async () => {
    await withWorkspace(async () => {
      await Wallet.create(createOptions());
      const wallet = await Wallet.create(createOptions({
        overwrite: true,
        card: { number: "5555555555554444", exp: "12/99", name: "Jane Replacement" }
      }));

      await expect(wallet.listCards()).resolves.toMatchObject([
        { brand: "mastercard", name_on_card: "Jane Replacement" }
      ]);
    });
  });

  it("refuses overwrite by default and rolls back files created during a failed create", async () => {
    await withWorkspace(async (root) => {
      await Wallet.create(createOptions());
      await expect(Wallet.create(createOptions())).rejects.toThrow(/vault file already exists/);

      await rm(join(root, ".steelyard"), { recursive: true, force: true });
      await expect(Wallet.create(createOptions({
        card: { number: "123", exp: "12/99", name: "Jane Doe" }
      }))).rejects.toThrow(/13-19 digits/);
      await expect(readFile(join(root, ".steelyard", "vault.box"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, ".steelyard", "policy.yml"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("opens project-only and applies global cannot overlay", async () => {
    await withWorkspace(async (root) => {
      process.env.HOME = join(root, "home");
      await Wallet.create(createOptions());
      await mkdir(join(root, "home", ".steelyard"), { recursive: true });
      await writeFile(join(root, "home", ".steelyard", "policy.yml"), `
version: "0.1"
default: deny
rules:
  - name: global block coffee
    cannot: buy
    where: { merchant_domain: coffee.example }
`);

      const wallet = await Wallet.open({ project: true });
      await expect(wallet.decide(intent)).resolves.toEqual({
        status: "denied",
        reason: "blocked by rule 'global block coffee'"
      });

      await rm(join(root, ".steelyard", "vault.box"), { force: true });
      await expect(Wallet.open({ project: true })).rejects.toThrow(/no project wallet found/);
    });
  });

  it("requires a password for password-derived vaults and maps keychain failures", async () => {
    await withWorkspace(async () => {
      await Wallet.create(createOptions({ password: "old password" }));
      await expect(Wallet.open({ project: true })).rejects.toThrow(/password required/);
      await expect(Wallet.open({ project: true, password: "old password" })).resolves.toBeInstanceOf(Wallet);
    });

    await withWorkspace(async () => {
      await Wallet.create(createOptions());
      keyringState.fail = true;
      await expect(Wallet.open({ project: true })).rejects.toBeInstanceOf(KeystoreUnavailable);
    });
  }, 45_000);
});

describe("Wallet decision, payment, and maintenance", () => {
  beforeEach(() => {
    keyringState.secrets.clear();
    keyringState.fail = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles denial, approval, raw card release, completion, and settlement races", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions({ approvalAbove: { USD: 4 } }));
      await expect(wallet.decide(intent)).resolves.toMatchObject({ status: "approval_required" });
      await expect(wallet.isAllowed(intent)).resolves.toBe(false);
      await expect(wallet.createBrowserManualSession(intent)).rejects.toBeInstanceOf(WalletApprovalRequired);

      const payment = await wallet.createBrowserManualSession(intent, { approval: { source: "user", ts: new Date().toISOString() } });
      let captured: { number: string; exp: string; name: string } | undefined;
      await expect(payment.revealCard((card) => {
        captured = card;
        return card.number;
      })).resolves.toBe("4111111111111111");
      expect(captured!.number).toMatch(/^0+$/);
      await payment.complete({ status: "completed", ref: "merchant_ref" });
      await expect(payment.cancel()).rejects.toThrow(/already settled/);
      await expect(wallet.listSpend()).resolves.toMatchObject([{ intent_id: "intent_coffee", status: "completed" }]);

      await wallet.setAllowedMerchants(["tea.example"]);
      await expect(wallet.createBrowserManualSession(intent)).rejects.toBeInstanceOf(WalletNotAllowed);
    });
  });

  it("runs merchant purchase through reservations and stores the receipt", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions());
      let releasedCard: { pan: string } | undefined;
      const merchant = merchantWithPurchase(async (_intent, opts) => {
        await opts.onTotalsKnown?.(450, "USD");
        await opts.port.withRawCard((card) => {
          releasedCard = card;
          return Promise.resolve();
        });
        expect(releasedCard!.pan).toMatch(/^0+$/);
        return purchaseReceipt(450);
      });

      const receipt = await wallet.purchase(intent, {
        merchant,
        idempotencyKey: "purchase_wallet",
        clock: () => purchaseClock
      });

      expect(releasedCard!.pan).toMatch(/^0+$/);
      expect(receipt.reference.acp?.checkout_session_id).toBe("cs_1");
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
      await expect(wallet.listReceipts()).resolves.toMatchObject([{ order_id: "order_1" }]);
      await expect(wallet.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 450 });
    });
  });

  it("releases the reservation when final totals exceed the authorized amount", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions());
      const merchant = merchantWithPurchase(async (_intent, opts) => {
        await opts.onTotalsKnown?.(451, "USD");
        throw new Error("should not tokenize");
      });

      await expect(wallet.purchase(intent, { merchant, clock: () => purchaseClock })).rejects.toBeInstanceOf(WalletAmountExceeded);
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
      await expect(wallet.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 0 });
    });
  });

  it("does not reserve merchant purchases that need policy approval", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions({ approvalAbove: { USD: 4 } }));
      const merchant = merchantWithPurchase(vi.fn(async () => purchaseReceipt()));

      await expect(wallet.purchase(intent, { merchant, clock: () => purchaseClock }))
        .rejects.toMatchObject({ name: "WalletApprovalRequired", kind: "policy" });
      expect(merchant.purchase).not.toHaveBeenCalled();
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
    });
  });

  it("releases reservations for merchant failures and currency mismatches", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions());
      const failingMerchant = merchantWithPurchase(async () => {
        throw new Error("HTTP 500");
      });

      await expect(wallet.purchase(intent, {
        merchant: failingMerchant,
        idempotencyKey: "merchant_failure",
        clock: () => purchaseClock
      })).rejects.toThrow(/HTTP 500/);
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
      await expect(wallet.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 0 });

      const mismatchMerchant = merchantWithPurchase(async (_intent, opts) => {
        await opts.onTotalsKnown?.(450, "EUR");
        throw new Error("should not charge after mismatch");
      });
      await expect(wallet.purchase(intent, {
        merchant: mismatchMerchant,
        idempotencyKey: "currency_mismatch",
        clock: () => purchaseClock
      })).rejects.toMatchObject({ name: "WalletAmountExceeded", currency: "EUR", reservation_released: true });
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
    });
  });

  it("releases reservations when a UCP-style mandate key is absent", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions({ mandateKey: false }));
      const merchant = merchantWithPurchase(async (_intent, opts) => {
        await opts.port.mandatePublicKey();
        throw new Error("unreachable");
      });

      await expect(wallet.purchase(intent, {
        merchant,
        idempotencyKey: "missing_mandate",
        clock: () => purchaseClock
      })).rejects.toBeInstanceOf(MandateKeyMissing);
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
    });
  });

  it("keeps resumable approval reservations claimed and resumes the same reservation", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions());
      const expiresAt = new Date(purchaseClock.getTime() + 5 * 60_000).toISOString();
      const challengeMerchant = merchantWithPurchase(async (_intent, opts) => {
        throw new WalletApprovalRequired({
          kind: "3ds",
          continue_url: "https://coffee.example/3ds",
          resume: {
            protocol: "acp",
            checkout_id: "cs_1",
            idempotency_key: opts.idempotencyKey ?? "missing",
            expires_at: expiresAt,
            reservation_id: opts.reservation_id ?? "missing"
          }
        });
      });

      let challenge: InstanceType<typeof WalletApprovalRequired> | undefined;
      try {
        await wallet.purchase(intent, {
          merchant: challengeMerchant,
          idempotencyKey: "resume_key",
          clock: () => purchaseClock
        });
      } catch (error) {
        challenge = error as InstanceType<typeof WalletApprovalRequired>;
      }

      expect(challenge).toBeInstanceOf(WalletApprovalRequired);
      if (!challenge) throw new Error("Expected approval challenge");
      expect(challenge.resume).toMatchObject({ checkout_id: "cs_1", idempotency_key: "resume_key" });
      await expect(wallet.pendingReservations()).resolves.toMatchObject([
        { id: challenge.resume!.reservation_id, status: "pending_escalated" }
      ]);
      await expect(wallet.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 450, captured: 0 });

      const resumeMerchant = merchantWithPurchase(async (_intent, opts) => {
        expect(opts.resume?.reservation_id).toBe(challenge.resume!.reservation_id);
        expect(opts.idempotencyKey).toBe("resume_key");
        await opts.onTotalsKnown?.(450, "USD");
        return purchaseReceipt(450);
      });
      await expect(wallet.purchase(intent, {
        merchant: resumeMerchant,
        resume: challenge.resume,
        clock: () => purchaseClock
      })).resolves.toMatchObject({ order_id: "order_1" });
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
    });
  });

  it("can release a pending approval reservation during reconciliation", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions());
      const expiresAt = new Date(purchaseClock.getTime() + 5 * 60_000).toISOString();
      const challengeMerchant = merchantWithPurchase(async (_intent, opts) => {
        throw new WalletApprovalRequired({
          kind: "escalation",
          continue_url: "https://coffee.example/review",
          resume: {
            protocol: "ucp",
            checkout_id: "checkout_1",
            idempotency_key: opts.idempotencyKey ?? "missing",
            expires_at: expiresAt,
            reservation_id: opts.reservation_id ?? "missing"
          }
        });
      });

      let challenge: InstanceType<typeof WalletApprovalRequired> | undefined;
      try {
        await wallet.purchase(intent, {
          merchant: challengeMerchant,
          idempotencyKey: "reconcile_release",
          clock: () => purchaseClock
        });
      } catch (error) {
        challenge = error as InstanceType<typeof WalletApprovalRequired>;
      }

      expect(challenge?.kind).toBe("escalation");
      await expect(wallet.pendingReservations()).resolves.toMatchObject([
        { id: challenge!.resume!.reservation_id, status: "pending_escalated" }
      ]);
      await wallet.reconcile(challenge!.resume!.reservation_id, {
        decision: "release",
        clock: () => purchaseClock
      });
      await expect(wallet.pendingReservations()).resolves.toEqual([]);
      await expect(wallet.spendInWindow("daily", "USD")).resolves.toEqual({ pending: 0, captured: 0 });
      await expect(wallet.reconcile(challenge!.resume!.reservation_id, {
        decision: "complete",
        clock: () => purchaseClock
      })).rejects.toThrow(/receipt required/);
    });
  });

  it("surfaces charged-but-unpersisted receipts for reconciliation", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions());
      const merchant = merchantWithPurchase(async (_intent, opts) => {
        await opts.onTotalsKnown?.(450, "USD");
        await wallet.close();
        return purchaseReceipt(450);
      });

      let failure: InstanceType<typeof ReceiptPersistenceFailed> | undefined;
      try {
        await wallet.purchase(intent, {
          merchant,
          idempotencyKey: "persist_fail",
          clock: () => purchaseClock
        });
      } catch (error) {
        failure = error as InstanceType<typeof ReceiptPersistenceFailed>;
      }

      expect(failure).toBeInstanceOf(ReceiptPersistenceFailed);
      if (!failure) throw new Error("Expected receipt persistence failure");
      expect(failure.shadow_persisted).toBe(false);
      expect(failure.receipt.order_id).toBe("order_1");

      const reopened = await Wallet.open({ project: true });
      await expect(reopened.pendingReservations()).resolves.toMatchObject([{ id: failure.reservation_id }]);
      await reopened.reconcile(failure.reservation_id, {
        decision: "complete",
        receipt: failure.receipt,
        clock: () => purchaseClock
      });
      await expect(reopened.listReceipts()).resolves.toMatchObject([{ order_id: "order_1" }]);
    });
  });

  it("updates wallet-owned policy sections while preserving user rules", async () => {
    await withWorkspace(async (root) => {
      const wallet = await Wallet.create(createOptions());
      const policyPath = join(root, ".steelyard", "policy.yml");
      const policy = parseDocument(await readFile(policyPath, "utf8")).toJSON() as any;
      policy.rules.push({ name: "user rule", can: "buy", where: { merchant_domain: "user.example" } });
      await writeFile(policyPath, stringify(policy));

      await wallet.setLimits({ daily: { USD: 60 }, weekly: { USD: 250 } });
      await wallet.setLimits({ USD: 50 });
      await expect(wallet.decide({ ...intent, amount: 5001 })).resolves.toMatchObject({ status: "denied", reason: "daily_limit_exceeded" });
      await wallet.setAllowedMerchants(["linear.app"]);
      await wallet.setApprovalAbove({ USD: 25 });
      await wallet.setApprovalAbove({});
      await wallet.setApprovalAbove({ USD: 25 });

      const updated = parseDocument(await readFile(policyPath, "utf8")).toJSON() as any;
      expect(updated.rules.some((rule: any) => rule.name === "user rule")).toBe(true);
      expect(updated.rules.find((rule: any) => rule.name === "steelyard.wallet.allowed_merchants").where.merchant_domain)
        .toEqual(["linear.app"]);
      expect(updated.rules.find((rule: any) => rule.name === "steelyard.wallet.allowed_merchants").requires_approval_above)
        .toEqual({ amount: 2500, currency: "USD" });

      updated.rules = updated.rules.filter((rule: any) => rule.name !== "steelyard.wallet.allowed_merchants");
      await writeFile(policyPath, stringify(updated));
      await expect(wallet.setAllowedMerchants(["coffee.example"])).rejects.toThrow(/wallet-owned policy section/);
    });
  });

  it("manages browser-manual instruments through named wallet APIs", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions());
      const created = await wallet.addInstrument(vaultedCard({
        number: "5555555555554444",
        exp: "12/99",
        name: "Jane Biz",
        label: "Work card",
        merchants: ["github.com"]
      }));

      expect(created).toMatchObject({
        mode: "browser-manual",
        type: "vaulted_card",
        label: "Work card",
        default: false
      });

      const initialChoice = await wallet.chooseInstrument(intent, { mode: "browser-manual" });
      expect(initialChoice.label).toContain("visa");
      await wallet.setDefaultInstrument(created.id);

      await expect(wallet.chooseInstrument(intent, { instrumentId: created.id })).resolves.toMatchObject({
        id: created.id,
        mode: "browser-manual",
        label: expect.stringContaining("mastercard"),
        default: true
      });
      const session = await wallet.createBrowserManualSession(intent, { instrumentId: created.id });
      expect(session).toBeInstanceOf(BrowserManualSession);
      await expect(session.revealCard((card) => card.number)).resolves.toBe("5555555555554444");

      await wallet.removeInstrument(created.id);
      await expect(wallet.chooseInstrument(intent, { instrumentId: created.id })).rejects.toThrow(/no matching payment instrument/);
    });
  });

  it("prepares agent-native mandates and exposes the issuer on merchant purchase ports", async () => {
    await withWorkspace(async () => {
      const noIssuer = await Wallet.create(createOptions({ overwrite: true }));
      await expect(noIssuer.prepareMandate(intent)).rejects.toThrow(/no agent-native payment instrument/);

      const minted: any[] = [];
      const issuer = {
        instrumentType: "shared_payment_token",
        async issueMandate(mandate: any) {
          minted.push(mandate);
          return {
            id: "spt_wallet_test",
            expires_at: Math.floor(Date.parse(mandate.payment.expires_at) / 1000),
            max_amount: mandate.payment.amount,
            currency: mandate.payment.currency,
            scope_proof: { type: "test_scope" }
          };
        }
      };
      const wallet = noIssuer;
      const instrument = await wallet.addInstrument({
        mode: "agent-native",
        type: "shared_payment_token",
        label: "Test SPT",
        issuer
      });

      await expect(wallet.listInstruments()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: instrument.id,
          mode: "agent-native",
          type: "shared_payment_token",
          label: "Test SPT",
          default: true
        })
      ]));

      await expect(wallet.prepareMandate(intent, {
        instrumentId: instrument.id,
        idempotencyKey: "credential_key",
        context: { x402: { requirementHash: "req_hash" } },
        clock: () => purchaseClock
      })).resolves.toMatchObject({
        id: "spt_wallet_test",
        max_amount: 450,
        currency: "USD"
      });
      expect(minted[0]).toMatchObject({
        nonce: "credential_key",
        merchant_id: "coffee.example",
        instrument_type: "shared_payment_token",
        context: { x402: { requirementHash: "req_hash" } },
        payment: { amount: 450, currency: "USD", checkout_id: "intent_coffee" }
      });
      await expect(wallet.prepareMandate(intent, { instrumentId: "missing" }))
        .rejects.toThrow(/agent-native payment instrument not found/);

      const merchant = merchantWithPurchase(async (_intent, opts) => {
        expect(opts.port.paymentMandateIssuer).toBe(issuer);
        await opts.onTotalsKnown?.(450, "USD");
        return purchaseReceipt(450);
      });
      await expect(wallet.purchase(intent, {
        merchant,
        instrumentId: instrument.id,
        idempotencyKey: "purchase_key",
        clock: () => purchaseClock
      })).resolves.toMatchObject({ order_id: "order_1" });

      await wallet.setDefaultInstrument(instrument.id);
      await expect(wallet.listInstruments()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: instrument.id, default: true })
      ]));
      await wallet.removeInstrument(instrument.id);
      await expect(wallet.prepareMandate(intent)).rejects.toThrow(/no agent-native payment instrument/);
    });
  });

  it("manages cards, billing, recovery, and password rotation", async () => {
    await withWorkspace(async (root) => {
      const wallet = await Wallet.create(createOptions({
        password: "old password",
        recovery: { path: join(root, "recovery.enc"), password: "recovery password" }
      }));
      await expect(readFile(join(root, "recovery.enc"), "utf8")).resolves.toContain("wrapped_key");
      await expect(wallet.exportRecovery({ path: join(root, "recovery-2.enc"), password: "second recovery" }))
        .resolves.toBe(join(root, "recovery-2.enc"));

      await wallet.addCard({
        number: "5555555555554444",
        exp: "12/99",
        name: "Jane Biz",
        merchants: ["github.com"],
        default: false
      });
      await wallet.setAllowedMerchants(["coffee.example", "github.com"]);
      await expect(wallet.createBrowserManualSession({ ...intent, merchant: { ...intent.merchant, domain: "github.com" } }))
        .resolves.toMatchObject({ metadata: { brand: "mastercard" } });
      const cards = await wallet.listCards();
      const biz = cards.find((card) => card.name_on_card === "Jane Biz")!;
      await wallet.setDefaultCard(biz.id);
      await expect(wallet.createBrowserManualSession(intent))
        .resolves.toMatchObject({ metadata: { brand: "mastercard" } });

      const original = cards.find((card) => card.name_on_card === "Jane Doe")!;
      await wallet.removeCard(biz.id);
      await expect(wallet.createBrowserManualSession(intent))
        .rejects.toBeInstanceOf(NoCardForMerchant);
      await wallet.setDefaultCard(original.id);

      await wallet.updateBilling({ address: { line1: "2 Main St", city: "SF", postal_code: "94111", country: "US" } });
      const payment = await wallet.createBrowserManualSession(intent);
      expect(payment.billing.address.line1).toBe("2 Main St");

      await wallet.rotatePassword({ oldPassword: "old password", newPassword: "new password" });
      await expect(Wallet.open({ project: true, password: "old password" })).rejects.toThrow();
      await expect(Wallet.open({ project: true, password: "new password" })).resolves.toBeInstanceOf(Wallet);
    });
  }, 70_000);
});
