// Copyright (c) Steelyard contributors. MIT License.
import { fork } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  StoreCasConflict,
  StoreNotFound,
  fileCheckoutSessionStore,
  memoryCheckoutSessionStore,
  type StoredCheckout
} from "./index.js";

const require = createRequire(import.meta.url);
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx/esm")).href;

const acpSession: StoredCheckout = {
  id: "cs_1",
  status: "ready_for_payment",
  protocol: { version: "2026-04-17" },
  currency: "USD",
  line_items: [],
  totals: [],
  fulfillment_options: [],
  messages: [],
  links: [],
  capabilities: {}
};

const ucpCheckout: StoredCheckout = {
  id: "chk_1",
  status: "ready_for_complete",
  ucp: { version: "2026-04-17", status: "success", payment_handlers: {} },
  currency: "USD",
  line_items: [],
  totals: [
    { type: "subtotal", amount: 0 },
    { type: "total", amount: 0 }
  ],
  links: []
};

describe("memoryCheckoutSessionStore", () => {
  it("puts, gets, lists, deletes, and clones sessions", async () => {
    const store = memoryCheckoutSessionStore();
    await store.put(acpSession);
    await store.put(ucpCheckout);

    const fromStore = await store.get("cs_1");
    expect(fromStore).toEqual(acpSession);
    fromStore!.status = "mutated";
    await expect(store.get("cs_1")).resolves.toMatchObject({ status: "ready_for_payment" });

    await expect(store.list({ status: "ready_for_payment" })).resolves.toEqual([acpSession]);
    await expect(store.list({ protocol: "ucp" })).resolves.toEqual([ucpCheckout]);
    await expect(store.list({ ids: ["missing"] })).resolves.toEqual([]);

    await store.delete("cs_1");
    await expect(store.get("cs_1")).resolves.toBeNull();
  });

  it("claims, commits, and rejects stale compare-and-set transitions", async () => {
    const store = memoryCheckoutSessionStore();
    const commits: string[] = [];
    await store.put(acpSession);

    const completed = await store.transition(
      "cs_1",
      "ready_for_payment",
      "complete_in_progress",
      async (current) => {
        expect(current.status).toBe("complete_in_progress");
        return {
          next: { ...current, status: "completed" },
          commit: async () => {
            commits.push("committed");
          }
        };
      }
    );

    expect(completed.status).toBe("completed");
    expect(commits).toEqual(["committed"]);
    await expect(store.get("cs_1")).resolves.toMatchObject({ status: "completed" });
    await expect(
      store.transition("cs_1", "ready_for_payment", "complete_in_progress", async (current) => ({
        next: current
      }))
    ).rejects.toBeInstanceOf(StoreCasConflict);
    await expect(
      store.transition("missing", "ready_for_payment", "complete_in_progress", async (current) => ({
        next: current
      }))
    ).rejects.toBeInstanceOf(StoreNotFound);
  });

  it("serializes concurrent transitions in-process", async () => {
    const store = memoryCheckoutSessionStore();
    await store.put({ ...acpSession, id: "race" });

    const transitions = await Promise.allSettled([
      store.transition("race", "ready_for_payment", "complete_in_progress", async (current) => {
        await delay(25);
        return { next: { ...current, status: "completed", winner: "a" } };
      }),
      store.transition("race", "ready_for_payment", "complete_in_progress", async (current) => {
        await delay(25);
        return { next: { ...current, status: "completed", winner: "b" } };
      })
    ]);

    expect(transitions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = transitions.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(StoreCasConflict);
  });
});

describe("fileCheckoutSessionStore", () => {
  it("persists sessions, filters by protocol, and writes private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-store-"));
    try {
      const store = fileCheckoutSessionStore({ dir: root });
      await store.put(acpSession);
      await store.put(ucpCheckout);

      await expect(fileCheckoutSessionStore({ dir: root }).get("cs_1")).resolves.toEqual(acpSession);
      await expect(store.list({ protocol: "acp" })).resolves.toEqual([acpSession]);
      await expect(store.list({ status: ["ready_for_complete"] })).resolves.toEqual([ucpCheckout]);

      expect(await fileMode(root)).toBe(0o700);
      const dataFiles = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
      expect(dataFiles).toHaveLength(2);
      await expect(fileMode(join(root, dataFiles[0]!))).resolves.toBe(0o600);

      await store.delete("chk_1");
      await expect(store.get("chk_1")).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an in-progress claim if the transition function fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-store-fail-"));
    try {
      const store = fileCheckoutSessionStore({ dir: root });
      await store.put({ ...acpSession, id: "cs_fail" });

      await expect(
        store.transition("cs_fail", "ready_for_payment", "complete_in_progress", async () => {
          throw new Error("psp unavailable");
        })
      ).rejects.toThrow(/psp unavailable/);

      await expect(store.get("cs_fail")).resolves.toMatchObject({ status: "complete_in_progress" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces malformed session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-store-malformed-"));
    try {
      const store = fileCheckoutSessionStore({ dir: root });
      await store.put({ ...acpSession, id: "cs_bad" });
      const dataFile = (await readdir(root)).find((name) => /^[a-f0-9]{64}\.json$/.test(name));
      await writeFile(join(root, dataFile!), "not json\n");

      await expect(store.get("cs_bad")).rejects.toThrow(/Unexpected token/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows exactly one OS process to win a CAS transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-store-race-"));
    try {
      const helperPath = join(root, "transition-child.mjs");
      await writeFile(helperPath, transitionChildSource(new URL("./store.ts", import.meta.url).href));
      const store = fileCheckoutSessionStore({ dir: root });
      await store.put({ ...acpSession, id: "race" });

      const results = await Promise.all([
        runTransitionChild({ helperPath, dir: root, winner: "a" }),
        runTransitionChild({ helperPath, dir: root, winner: "b" })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ name: "StoreCasConflict" })
      ]);
      await expect(store.get("race")).resolves.toMatchObject({ status: "completed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface ChildResult {
  ok: boolean;
  name?: string;
  message?: string;
  winner?: string;
}

function transitionChildSource(storeModuleUrl: string): string {
  return `
import { fileCheckoutSessionStore } from ${JSON.stringify(storeModuleUrl)};

try {
  const store = fileCheckoutSessionStore({ dir: process.env.STEELYARD_STORE_DIR });
  const next = await store.transition("race", "ready_for_payment", "complete_in_progress", async (current) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { next: { ...current, status: "completed", winner: process.env.STEELYARD_WINNER } };
  });
  process.send?.({ ok: true, winner: next.winner });
} catch (error) {
  process.send?.({
    ok: false,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  });
}
`;
}

async function runTransitionChild(opts: {
  helperPath: string;
  dir: string;
  winner: string;
}): Promise<ChildResult> {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  const child = fork(opts.helperPath, [], {
    execArgv: ["--import", tsxLoaderUrl],
    env: {
      ...env,
      STEELYARD_STORE_DIR: opts.dir,
      STEELYARD_WINNER: opts.winner
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let stderr = "";
  let result: ChildResult | undefined;
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (message) => {
    result = message as ChildResult;
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`transition child timed out${stderr ? `: ${stderr}` : ""}`));
    }, 10_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (result) {
        resolve(result);
        return;
      }
      reject(new Error(`transition child exited without result: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });
}

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
