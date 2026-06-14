import { describe, expect, it } from "vitest";
import type { Merchant } from "@steelyard/buyer/client";
import { parseNaivePrompt, runAgent, DEFAULT_ANTHROPIC_MODEL, type AgentOutput } from "./index.js";

const offers = [
  {
    id: "single",
    title: "Single Espresso",
    images: [],
    kind: "product" as const,
    categories: ["espresso"],
    attributes: {},
    availability: "in_stock" as const,
    pricing: [{ kind: "one_time" as const, amount: 300, currency: "USD" }]
  },
  {
    id: "double",
    title: "Double Espresso",
    images: [],
    kind: "product" as const,
    categories: ["espresso"],
    attributes: {},
    availability: "in_stock" as const,
    pricing: [{ kind: "one_time" as const, amount: 450, currency: "USD" }]
  }
];

const merchant: Merchant = {
  id: "coffee.example",
  protocol: "mcp",
  url: "http://merchant",
  supports: (capability) => capability === "read",
  search: async () => offers,
  lookup: async (id) => offers.find((offer) => offer.id === id) ?? { error: "not_found" },
  getOffer: async (id) => offers.find((offer) => offer.id === id) ?? { error: "not_found" },
  getManifest: async () => ({
    schemaVersion: "0.1",
    identity: { name: "Coffee", currencies: [] },
    catalog: { offers },
    policies: []
  }),
  getPolicies: async () => [{ type: "returns", summary: "Prepared drinks are final." }],
  purchase: async () => {
    throw new Error("checkout is unavailable");
  }
};

describe("runAgent", () => {
  it("prints help for --help and missing args", async () => {
    const out = capture();

    expect(await runAgent(["--help"], {}, out, { connect: async () => merchant })).toBe(0);
    expect(out.stdoutText()).toContain("Usage:");
    expect(await runAgent([], {}, out, { connect: async () => merchant })).toBe(1);
    expect(out.stderrText()).toContain("Usage:");
  });

  it("uses the naive list path when no Anthropic key is set", async () => {
    const out = capture();
    let closed = false;
    const code = await runAgent(
      ["--merchant", "http://merchant", "what does this shop sell"],
      {},
      out,
      { connect: async () => ({ ...merchant, close: async () => { closed = true; } }) }
    );

    expect(code).toBe(0);
    expect(closed).toBe(true);
    expect(out.stdoutText()).toContain("running without LLM");
    expect(out.stdoutText()).toContain("Single Espresso");
  });

  it("waits for naive merchant calls before closing the merchant", async () => {
    const out = capture();
    let closed = false;
    const slowMerchant: Merchant = {
      ...merchant,
      search: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return closed ? { error: "internal_error" } : offers;
      },
      close: async () => {
        closed = true;
      }
    };

    const code = await runAgent(
      ["--merchant", "http://merchant", "what does this shop sell"],
      {},
      out,
      { connect: async () => slowMerchant }
    );

    expect(code).toBe(0);
    expect(closed).toBe(true);
    expect(out.stdoutText()).toContain("Double Espresso");
  });

  it("supports naive offer and policies prompts", async () => {
    const offerOut = capture();
    const policyOut = capture();

    expect(
      await runAgent(["--merchant", "http://merchant", "show offer single"], {}, offerOut, {
        connect: async () => merchant
      })
    ).toBe(0);
    expect(offerOut.stdoutText()).toContain("Single Espresso");

    expect(
      await runAgent(["--merchant", "http://merchant", "tell me policies"], {}, policyOut, {
        connect: async () => merchant
      })
    ).toBe(0);
    expect(policyOut.stdoutText()).toContain("Prepared drinks");
  });

  it("returns non-zero for unparseable naive prompts and connect errors", async () => {
    const badPrompt = capture();
    const badConnect = capture();

    expect(
      await runAgent(["--merchant", "http://merchant", "dance"], {}, badPrompt, {
        connect: async () => merchant
      })
    ).toBe(1);
    expect(badPrompt.stderrText()).toContain("Try:");

    expect(
      await runAgent(["--merchant", "http://merchant", "what does this shop sell"], {}, badConnect, {
        connect: async () => ({ error: "protocol_mismatch" })
      })
    ).toBe(1);
    expect(badConnect.stderrText()).toBe("protocol_mismatch");
  });

  it("uses Anthropic when a key is set", async () => {
    const out = capture();
    const calls: unknown[] = [];

    const code = await runAgent(
      ["--merchant", "http://merchant", "what does this shop sell"],
      { ANTHROPIC_API_KEY: "key" },
      out,
      {
        connect: async () => merchant,
        createAnthropic: (apiKey) => ({
          messages: {
            create: async (input) => {
              calls.push({ apiKey, input });
              return { content: [{ type: "text", text: "This shop sells Single Espresso and Double Espresso." }] };
            }
          }
        })
      }
    );

    expect(code).toBe(0);
    expect(out.stdoutText()).toContain("Single Espresso");
    expect(JSON.stringify(calls)).toContain(DEFAULT_ANTHROPIC_MODEL);
  });

  it("falls back to naive parsing when Anthropic fails", async () => {
    const out = capture();

    const code = await runAgent(
      ["--merchant", "http://merchant", "what does this shop sell"],
      { ANTHROPIC_API_KEY: "key" },
      out,
      {
        connect: async () => merchant,
        createAnthropic: () => ({
          messages: {
            create: async () => {
              throw new Error("503 overloaded");
            }
          }
        })
      }
    );

    expect(code).toBe(0);
    expect(out.stdoutText()).toContain("LLM provider failed: 503 overloaded");
    expect(out.stdoutText()).toContain("Double Espresso");
  });
});

describe("parseNaivePrompt", () => {
  it("accepts the five sample prompt forms", () => {
    expect(parseNaivePrompt("what does this shop sell")).toEqual({ action: "list" });
    expect(parseNaivePrompt("tell me what you sell")).toEqual({ action: "list" });
    expect(parseNaivePrompt("show me what you sell")).toEqual({ action: "list" });
    expect(parseNaivePrompt("show offer single")).toEqual({ action: "offer", id: "single" });
    expect(parseNaivePrompt("tell me policies")).toEqual({ action: "policies" });
  });
});

function capture(): AgentOutput & { stdoutText(): string; stderrText(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    stdoutText: () => stdout.join("\n"),
    stderrText: () => stderr.join("\n")
  };
}
