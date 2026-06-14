import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuyerVault } from "./index.js";
import { VAULT_KEY_SERVICE, osKeystore } from "./keystore.js";
import { accountForVault } from "./vault.js";

const keychainLane = process.env.STEELYARD_TEST_KEYSTORE === "keychain";
const darwinKeychain = keychainLane && process.platform === "darwin";
const linuxKeychain = keychainLane && process.platform === "linux";

describe("BuyerVault real OS keychain integration", () => {
  const runDarwin = darwinKeychain ? it : it.skip;
  const runLinux = linuxKeychain ? it : it.skip;

  runDarwin("@platform=darwin-keychain stores and reopens a card through macOS Keychain", async () => {
    await expect(roundTripRealKeychainVault()).resolves.toBe("1111");
  });

  runLinux("@platform=linux-keychain stores and reopens a card through Secret Service", async () => {
    await expect(roundTripRealKeychainVault()).resolves.toBe("1111");
  });
});

async function roundTripRealKeychainVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-os-keychain-"));
  const vaultPath = join(root, "vault.box");
  let uuid: string | undefined;
  try {
    const vault = await BuyerVault.init({
      path: vaultPath,
      profile: { name: "Keychain Buyer", email: "keychain@example.com" }
    });
    uuid = vault.uuid;
    await vault.addCard({
      name_on_card: "Keychain Buyer",
      pan: "4111111111111111",
      exp: "12/99",
      tags: ["default"]
    });
    await vault.close();

    const reopened = await BuyerVault.open({ path: vaultPath });
    const picked = await reopened.pickCard({ merchant: "coffee.example" });
    expect(picked).toMatchObject({ last4: "1111", brand: "visa" });
    const raw = await reopened.revealCard(picked!.id);
    await reopened.close();
    return raw.last4;
  } finally {
    if (uuid) {
      await osKeystore().deleteMasterKey(VAULT_KEY_SERVICE, accountForVault(uuid)).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}
