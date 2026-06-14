import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { BuyerVault, memoryBoxStore, memoryKeystore } from "./index.js";

async function createVault() {
  const boxStore = memoryBoxStore();
  const keystore = memoryKeystore();
  const vault = await BuyerVault.init({
    path: "/tmp/vault.box",
    profile: { name: "Jane Doe", email: "jane@example.com" },
    keystore,
    boxStore
  });
  return { vault, boxStore, keystore };
}

describe("BuyerVault card CRUD", () => {
  it("stores cards encrypted, lists metadata only, and reveals PANs with redacted logging", async () => {
    const { vault, boxStore, keystore } = await createVault();

    const card = await vault.addCard({
      id: "personal",
      name_on_card: " Jane Doe ",
      pan: "4111 1111 1111 1111",
      exp: "12/99",
      tags: ["GitHub.com", "default", "default"]
    });
    expect(card).toEqual({
      id: "personal",
      name_on_card: "Jane Doe",
      exp: "12/99",
      brand: "visa",
      last4: "1111",
      tags: ["github.com", "default"]
    });
    expect(card).not.toHaveProperty("pan");

    const rawBox = await boxStore.read("vault.box");
    expect(Buffer.from(rawBox!).includes(Buffer.from("4111111111111111"))).toBe(false);

    const reopened = await BuyerVault.open({ path: "/tmp/vault.box", keystore, boxStore });
    await expect(reopened.listCards()).resolves.toEqual([card]);

    const raw = await reopened.revealCard("personal");
    expect(raw.pan).toBe("4111111111111111");
    expect(JSON.stringify(raw)).toContain("****1111");
    expect(JSON.stringify(raw)).not.toContain("4111111111111111");
    expect(inspect(raw)).toContain("****1111");
    expect(inspect(raw)).not.toContain("4111111111111111");
  });

  it("validates PAN, expiry, ids, duplicate cards, and explicit Luhn bypass", async () => {
    const { vault } = await createVault();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        vault.addCard({ id: "bad_luhn", name_on_card: "Jane", pan: "4111111111111112", exp: "12/99" })
      ).rejects.toThrow(/Luhn/);
      await expect(
        vault.addCard({ id: "too_short", name_on_card: "Jane", pan: "123", exp: "12/99" })
      ).rejects.toThrow(/13-19 digits/);
      await expect(
        vault.addCard({ id: "expired", name_on_card: "Jane", pan: "4111111111111111", exp: "01/20" })
      ).rejects.toThrow(/past/);
      await expect(
        vault.addCard({ id: "bad exp", name_on_card: "Jane", pan: "4111111111111111", exp: "2099-12" })
      ).rejects.toThrow(/MM\/YY/);
      await expect(
        vault.addCard({ id: "bad id", name_on_card: "Jane", pan: "4111111111111111", exp: "12/99" })
      ).rejects.toThrow(/card id/);

      const bypassed = await vault.addCard({
        id: "private_network",
        name_on_card: "Jane",
        pan: "4111111111111112",
        exp: "12/99",
        skipLuhn: true
      });
      expect(bypassed.last4).toBe("1112");
      expect(stderr).toHaveBeenCalledTimes(1);
      await expect(
        vault.addCard({
          id: "discover",
          name_on_card: "Jane",
          pan: "6011111111111117",
          exp: "12/99"
        })
      ).resolves.toMatchObject({ brand: "discover" });
      await expect(
        vault.addCard({
          id: "other_brand",
          name_on_card: "Jane",
          pan: "30569309025904",
          exp: "12/99"
        })
      ).resolves.toMatchObject({ brand: "other" });
      await expect(
        vault.addCard({ id: "private_network", name_on_card: "Jane", pan: "5555555555554444", exp: "12/99" })
      ).rejects.toThrow(/already exists/);
    } finally {
      stderr.mockRestore();
    }
  });

  it("picks cards by exact tag, glob tag, default tag, then null", async () => {
    const { vault } = await createVault();
    await vault.addCard({
      id: "fallback",
      name_on_card: "Jane",
      pan: "4111111111111111",
      exp: "12/99",
      tags: ["default"]
    });
    await vault.addCard({
      id: "glob",
      name_on_card: "Jane",
      pan: "5555555555554444",
      exp: "12/99",
      tags: ["*.github.com"]
    });
    await vault.addCard({
      id: "exact",
      name_on_card: "Jane",
      pan: "378282246310005",
      exp: "12/99",
      tags: ["api.github.com"]
    });

    await expect(vault.pickCard({ merchant: "https://API.GITHUB.com:443/path" })).resolves.toMatchObject({
      id: "exact",
      brand: "amex"
    });
    await expect(vault.pickCard({ merchant: "docs.github.com" })).resolves.toMatchObject({
      id: "glob",
      brand: "mastercard"
    });
    await expect(vault.pickCard({ merchant: "example.com" })).resolves.toMatchObject({ id: "fallback" });

    await vault.removeCard("fallback");
    await expect(vault.pickCard({ merchant: "example.com" })).resolves.toBeNull();
    await expect(vault.revealCard("fallback")).rejects.toThrow(/card not found/);
  });
});

describe("BuyerVault address CRUD", () => {
  it("stores billing addresses, manages defaults, and returns billing payloads", async () => {
    const { vault } = await createVault();

    const home = await vault.addAddress({
      id: "home",
      line1: " 1 Market Street ",
      city: " London ",
      postal_code: "SW1A 1AA",
      country: "gb"
    });
    const office = await vault.addAddress({
      id: "office",
      line1: "2 Work Road",
      line2: "Floor 3",
      city: "London",
      postal_code: "EC1A 1BB",
      country: "GB",
      state: "LND"
    });

    expect(home).toEqual({
      id: "home",
      line1: "1 Market Street",
      city: "London",
      postal_code: "SW1A 1AA",
      country: "GB"
    });
    expect(office).toMatchObject({ id: "office", line2: "Floor 3", state: "LND" });
    await expect(vault.billing()).resolves.toMatchObject({
      name: "Jane Doe",
      email: "jane@example.com",
      address: { id: "home" }
    });

    await vault.setDefaultAddress("office");
    await expect(vault.billing()).resolves.toMatchObject({ address: { id: "office" } });
    await expect(vault.billing({ addressId: "home" })).resolves.toMatchObject({ address: { id: "home" } });

    const listed = await vault.listAddresses();
    expect(listed).toHaveLength(2);
    expect(listed[0]).not.toHaveProperty("default");
    listed[0]!.line1 = "mutated";
    expect((await vault.listAddresses())[0]).toMatchObject({ line1: "1 Market Street" });

    await vault.removeAddress("office");
    await expect(vault.billing()).resolves.toMatchObject({ address: { id: "home" } });
    await vault.removeAddress("home");
    await expect(vault.billing()).rejects.toThrow(/no billing address/);
  });

  it("rejects malformed and duplicate addresses", async () => {
    const { vault } = await createVault();
    await expect(
      vault.addAddress({ id: "bad", line1: "1", city: "London", postal_code: "SW1", country: "GBR" })
    ).rejects.toThrow(/ISO 3166-1/);
    await expect(
      vault.addAddress({ id: "blank", line1: " ", city: "London", postal_code: "SW1", country: "GB" })
    ).rejects.toThrow(/line1/);
    await expect(
      vault.addAddress({ id: "bad id", line1: "1", city: "London", postal_code: "SW1", country: "GB" })
    ).rejects.toThrow(/address id/);

    await vault.addAddress({ id: "home", line1: "1", city: "London", postal_code: "SW1", country: "GB" });
    await expect(
      vault.addAddress({ id: "home", line1: "2", city: "London", postal_code: "SW2", country: "GB" })
    ).rejects.toThrow(/already exists/);
    await expect(vault.setDefaultAddress("missing")).rejects.toThrow(/address not found/);
    await expect(vault.removeAddress("missing")).rejects.toThrow(/address not found/);
    await expect(vault.billing({ addressId: "missing" })).rejects.toThrow(/no billing address/);
  });

  it("rejects CRUD methods after close", async () => {
    const { vault } = await createVault();
    await vault.close();

    await expect(vault.listCards()).rejects.toThrow(/vault is closed/);
    await expect(
      vault.addAddress({ line1: "1", city: "London", postal_code: "SW1", country: "GB" })
    ).rejects.toThrow(/vault is closed/);
    await expect(vault.billing()).rejects.toThrow(/vault is closed/);
  });
});
