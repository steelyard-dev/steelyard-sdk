import type { PurchaseIntent } from "@steelyard/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  WalletApprovalRequired,
  WalletNotAllowed,
  NoCardForMerchant,
  KeystoreUnavailable,
  MandateKeyMissing
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

      const payment = await wallet.pay(intent);
      expect(payment.metadata).toEqual({ brand: "visa", last4: "1111", exp: "12/99", name: "Jane Doe" });
      expect(JSON.stringify(payment.metadata)).not.toContain("4111111111111111");

      const reopened = await Wallet.open({ project: true });
      await expect(reopened.hasMandateKey()).resolves.toBe(true);
      await expect(reopened.exportMandatePublicKey()).resolves.toEqual(publicKey);
      await expect(reopened.isAllowed(intent)).resolves.toBe(true);
      await expect(reopened.decide({ ...intent, merchant: { ...intent.merchant, domain: "blocked.example" } }))
        .resolves.toEqual({ status: "denied", reason: "default deny" });
    });
  });

  it("can skip the default mandate key and create it later", async () => {
    await withWorkspace(async () => {
      const wallet = await Wallet.create(createOptions({ mandateKey: false }));

      await expect(wallet.hasMandateKey()).resolves.toBe(false);
      await expect(wallet.exportMandatePublicKey()).rejects.toBeInstanceOf(MandateKeyMissing);

      const created = await wallet.createMandateKey();
      expect(created).toMatchObject({ key_id: expect.stringMatching(/^mk_/), algorithm: "Ed25519" });
      await expect(wallet.hasMandateKey()).resolves.toBe(true);
      await expect(wallet.exportMandatePublicKey()).resolves.toMatchObject({ key_id: created.key_id });
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
  }, 20_000);
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
      await expect(wallet.pay(intent)).rejects.toBeInstanceOf(WalletApprovalRequired);

      const payment = await wallet.pay(intent, { approval: { source: "user", ts: new Date().toISOString() } });
      let captured: { number: string; exp: string; name: string } | undefined;
      await expect(payment.withRawCard((card) => {
        captured = card;
        return card.number;
      })).resolves.toBe("4111111111111111");
      expect(captured!.number).toMatch(/^0+$/);
      await payment.complete({ status: "completed", ref: "merchant_ref" });
      await expect(payment.cancel()).rejects.toThrow(/already settled/);
      await expect(wallet.listSpend()).resolves.toMatchObject([{ intent_id: "intent_coffee", status: "completed" }]);

      await wallet.setAllowedMerchants(["tea.example"]);
      await expect(wallet.pay(intent)).rejects.toBeInstanceOf(WalletNotAllowed);
    });
  });

  it("updates wallet-owned policy sections while preserving user rules", async () => {
    await withWorkspace(async (root) => {
      const wallet = await Wallet.create(createOptions());
      const policyPath = join(root, ".steelyard", "policy.yml");
      const policy = parseDocument(await readFile(policyPath, "utf8")).toJSON() as any;
      policy.rules.push({ name: "user rule", can: "buy", where: { merchant_domain: "user.example" } });
      await writeFile(policyPath, stringify(policy));

      await wallet.setLimits({ USD: 50 });
      await expect(wallet.decide({ ...intent, amount: 5001 })).resolves.toMatchObject({ status: "denied", reason: "daily_limit_exceeded" });
      await wallet.setAllowedMerchants(["linear.app"]);
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

  it("manages cards, billing, recovery, and password rotation", async () => {
    await withWorkspace(async (root) => {
      const wallet = await Wallet.create(createOptions({
        password: "old password",
        recovery: { path: join(root, "recovery.enc"), password: "recovery password" }
      }));
      await expect(readFile(join(root, "recovery.enc"), "utf8")).resolves.toContain("wrapped_key");

      await wallet.addCard({
        number: "5555555555554444",
        exp: "12/99",
        name: "Jane Biz",
        merchants: ["github.com"],
        default: false
      });
      await wallet.setAllowedMerchants(["coffee.example", "github.com"]);
      await expect(wallet.pay({ ...intent, merchant: { ...intent.merchant, domain: "github.com" } }))
        .resolves.toMatchObject({ metadata: { brand: "mastercard" } });
      const cards = await wallet.listCards();
      const biz = cards.find((card) => card.name_on_card === "Jane Biz")!;
      await wallet.setDefaultCard(biz.id);
      await expect(wallet.pay(intent))
        .resolves.toMatchObject({ metadata: { brand: "mastercard" } });

      const original = cards.find((card) => card.name_on_card === "Jane Doe")!;
      await wallet.removeCard(biz.id);
      await expect(wallet.pay(intent))
        .rejects.toBeInstanceOf(NoCardForMerchant);
      await wallet.setDefaultCard(original.id);

      await wallet.updateBilling({ address: { line1: "2 Main St", city: "SF", postal_code: "94111", country: "US" } });
      const payment = await wallet.pay(intent);
      expect(payment.billing.address.line1).toBe("2 Main St");

      await wallet.rotatePassword({ oldPassword: "old password", newPassword: "new password" });
      await expect(Wallet.open({ project: true, password: "old password" })).rejects.toThrow();
      await expect(Wallet.open({ project: true, password: "new password" })).resolves.toBeInstanceOf(Wallet);
    });
  }, 70_000);
});
