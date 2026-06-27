import { describe, expect, it } from "vitest";
import { loadInspectorPageTemplate } from "./templates.js";

describe("loadInspectorPageTemplate", () => {
  it("returns the raw .tsx source string", () => {
    const src = loadInspectorPageTemplate();
    expect(src).toContain("Steelyard Inspector");
    expect(src).toContain("export default async function SteelyardInspector");
  });
});
