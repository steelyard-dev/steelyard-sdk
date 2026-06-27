import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createUi } from "./ui.js";
import type { CliIO } from "../io.js";

function fakeIo(overrides: Partial<{ noColor: boolean; tty: boolean }> = {}): CliIO & { _out: string[] } {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const tty = overrides.tty ?? true;
  const stdout = Object.assign(out, {
    isTTY: tty,
    cursorTo: () => true,
    moveCursor: () => true,
    clearLine: () => true,
    columns: 80,
    rows: 24,
    getColorDepth: () => (tty ? 8 : 1)
  });
  return {
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    env: overrides.noColor ? { NO_COLOR: "1" } : {},
    cwd: process.cwd(),
    _out: chunks
  } as CliIO & { _out: string[] };
}

describe("ui.line / ui.success / ui.warn", () => {
  it("writes formatted lines to stdout", () => {
    const io = fakeIo();
    const ui = createUi(io);
    ui.line("hello");
    ui.success("done");
    ui.warn("hmm");
    const text = io._out.join("");
    expect(text).toContain("hello");
    expect(text).toContain("done");
    expect(text).toContain("hmm");
  });

  it("suppresses ANSI codes when NO_COLOR=1", () => {
    const io = fakeIo({ noColor: true });
    const ui = createUi(io);
    ui.success("done");
    const text = io._out.join("");
    expect(text).not.toMatch(/\[/);
  });
});

describe("ui.spinner", () => {
  it("returns a spinner that can succeed and fail without throwing", () => {
    const io = fakeIo({ tty: false });
    const ui = createUi(io);
    const spin = ui.spinner("working");
    expect(() => spin.succeed("ok")).not.toThrow();
    expect(() => spin.update("ignored")).not.toThrow();
    expect(() => spin.stop()).not.toThrow();
    const spin2 = ui.spinner("working");
    expect(() => spin2.fail("nope")).not.toThrow();
    const spin3 = ui.spinner("working");
    expect(() => spin3.succeed()).not.toThrow();
    const spin4 = ui.spinner("working");
    expect(() => spin4.fail()).not.toThrow();
  });

  it("drives ora when stdout is a TTY", () => {
    const io = fakeIo({ tty: true });
    const ui = createUi(io);
    const spin = ui.spinner("working");
    expect(() => spin.update("still working")).not.toThrow();
    expect(() => spin.succeed("ok")).not.toThrow();
    const spin2 = ui.spinner("working");
    expect(() => spin2.fail("nope")).not.toThrow();
    const spin3 = ui.spinner("working");
    expect(() => spin3.stop()).not.toThrow();
    const spin4 = ui.spinner("working");
    expect(() => spin4.succeed()).not.toThrow();
    const spin5 = ui.spinner("working");
    expect(() => spin5.fail()).not.toThrow();
  });
});

describe("ui.error / ui.dim / ui.prompt", () => {
  it("writes error lines and returns dim strings", () => {
    const io = fakeIo();
    const ui = createUi(io);
    ui.error("boom");
    const dimmed = ui.dim("subtle");
    expect(io._out.join("")).toContain("boom");
    expect(dimmed).toContain("subtle");
  });

  it("returns the answer when prompts is injected", async () => {
    const io = fakeIo();
    const ui = createUi(io);
    // prompts supports scripted answers via .inject()
    const { default: prompts } = await import("prompts");
    prompts.inject(["yes"]);
    const result = await ui.prompt<"value">({ type: "text", name: "value", message: "?" });
    expect(result.value).toBe("yes");
  });
});
