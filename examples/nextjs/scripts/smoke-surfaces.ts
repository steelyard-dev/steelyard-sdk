// Boots `next start` against the prebuilt app, hits the four well-known surfaces,
// asserts spec compliance, exits non-zero on failure.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT ?? "31415";
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  const child = spawn("pnpm", ["start", "-p", PORT], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, NODE_ENV: "production", STRIPE_SECRET_KEY: "sk_test_fake" }
  });

  // Wait for the server to be ready
  let ready = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    process.stdout.write(s);
    if (s.includes("Ready in") || s.includes("started server on")) ready = true;
  });
  for (let i = 0; i < 60 && !ready; i++) await sleep(500);
  if (!ready) {
    child.kill();
    throw new Error("server didn't start within 30s");
  }

  try {
    await assertJsonSurface(`${BASE}/.well-known/commerce.json`, (b) => {
      if (!b.identity) throw new Error("missing identity");
      const offers = b.offers ?? b.catalog?.offers;
      if (!Array.isArray(offers)) throw new Error("missing offers[]");
      if (offers.length !== 3) throw new Error(`expected 3 offers, got ${offers.length}`);
    });
    await assertJsonSurface(`${BASE}/acp/feed`, (b) => {
      if (!Array.isArray(b.products)) throw new Error("missing products[]");
    });
    await assertJsonSurface(`${BASE}/.well-known/ucp`, (b) => {
      // UCP discovery wraps protocol info under a top-level `ucp` key.
      const node = b.ucp ?? b;
      if (!node.version) throw new Error("missing ucp.version");
      if (!node.services) throw new Error("missing ucp.services");
    });
    // MCP requires POST
    const mcpRes = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    // MCP may return 200 (success) or 400 (request shape rejected) — either proves the route is wired.
    // It should NOT 5xx.
    if (mcpRes.status >= 500) throw new Error(`mcp POST returned ${mcpRes.status}`);
    console.log(`OK: ${BASE}/mcp returned ${mcpRes.status}`);
    console.log("OK: all four surfaces responding");
  } finally {
    child.kill();
  }
}

async function assertJsonSurface(url: string, check: (body: any) => void) {
  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`${url} returned ${res.status}`);
  const body = await res.json();
  check(body);
  console.log(`OK: ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
