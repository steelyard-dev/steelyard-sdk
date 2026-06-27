import { describe, expect, it } from "vitest";
import { renderBanner } from "./banner.js";

describe("renderBanner", () => {
  it("returns a multi-line ASCII banner with tagline", () => {
    const out = renderBanner({ tty: true, noColor: true });
    expect(out.split("\n").length).toBeGreaterThanOrEqual(6);
    expect(out).toContain("STEELYARD");
    expect(out).toContain("Define commerce once");
  });

  it("returns an empty string when stdout is not a TTY", () => {
    expect(renderBanner({ tty: false, noColor: false })).toBe("");
  });

  it("suppresses color codes when noColor is true", () => {
    const out = renderBanner({ tty: true, noColor: true });
    // ANSI CSI introducer [
    expect(out).not.toMatch(/\[/);
  });
});
