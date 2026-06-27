import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writePlanTransactional, type WritePlanEntry } from "./codegen.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "steelyard-cg-"));
}

describe("writePlanTransactional", () => {
  it("creates files and parent dirs", async () => {
    const root = tmp();
    const plan: WritePlanEntry[] = [
      { path: "app/mcp/route.ts", contents: "export const GET = () => {}" },
      { path: "commerce.ts", contents: "export default {}" }
    ];
    const result = await writePlanTransactional(root, plan, { overwrite: "fail" });
    expect(result.ok).toBe(true);
    expect(readFileSync(resolve(root, "app/mcp/route.ts"), "utf8")).toContain("export const GET");
    expect(readFileSync(resolve(root, "commerce.ts"), "utf8")).toContain("export default");
  });

  it("rolls back created files if a later write fails", async () => {
    const root = tmp();
    // Create a file named 'blocked' so that writing to 'blocked/file.ts' fails
    // (can't mkdir a path where a file already exists).
    writeFileSync(resolve(root, "blocked"), "x");
    const plan: WritePlanEntry[] = [
      { path: "app/mcp/route.ts", contents: "ok" },
      { path: "blocked/file.ts", contents: "boom" }
    ];
    const result = await writePlanTransactional(root, plan, { overwrite: "fail" });
    expect(result.ok).toBe(false);
    expect(existsSync(resolve(root, "app/mcp/route.ts"))).toBe(false);
  });

  it("respects overwrite='fail' when a target file already exists", async () => {
    const root = tmp();
    mkdirSync(resolve(root, "app/mcp"), { recursive: true });
    writeFileSync(resolve(root, "app/mcp/route.ts"), "existing");
    const result = await writePlanTransactional(
      root,
      [{ path: "app/mcp/route.ts", contents: "new" }],
      { overwrite: "fail" }
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(resolve(root, "app/mcp/route.ts"), "utf8")).toBe("existing");
  });

  it("overwrites when overwrite='replace'", async () => {
    const root = tmp();
    mkdirSync(resolve(root, "app/mcp"), { recursive: true });
    writeFileSync(resolve(root, "app/mcp/route.ts"), "existing");
    const result = await writePlanTransactional(
      root,
      [{ path: "app/mcp/route.ts", contents: "new" }],
      { overwrite: "replace" }
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(resolve(root, "app/mcp/route.ts"), "utf8")).toBe("new");
  });
});
