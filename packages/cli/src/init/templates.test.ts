import { describe, expect, it } from "vitest";
import {
  renderWellKnownRoute,
  renderMcpRoute,
  renderAcpFeedRoute,
  renderUcpRoute,
  renderManifestStub,
  renderEnvLocalAddition
} from "./templates.js";

describe("route templates", () => {
  it("wellKnown route imports the manifest at the configured path", () => {
    const out = renderWellKnownRoute({ manifestImport: "@/commerce" });
    expect(out).toContain('import manifestModule from "@/commerce"');
    expect(out).toContain("createCommerceRoutes");
    expect(out).toContain("export const GET");
  });

  it("mcp route handles POST + OPTIONS", () => {
    const out = renderMcpRoute({ manifestImport: "@/commerce" });
    expect(out).toContain("export const POST");
    expect(out).toContain("export const GET");
  });

  it("acp feed route exposes GET", () => {
    const out = renderAcpFeedRoute({ manifestImport: "@/commerce" });
    expect(out).toContain("export const GET");
    expect(out).toContain("routes.acpFeed");
  });

  it("ucp route handles a catch-all path segment", () => {
    const out = renderUcpRoute({ manifestImport: "@/commerce" });
    expect(out).toContain("[...path]");
    expect(out).toContain("export const GET");
    expect(out).toContain("export const POST");
  });

  it("manifest stub is valid TS importable code", () => {
    const out = renderManifestStub({
      identity: { name: "Acme", domain: "acme.example", currencies: ["USD"] },
      offers: []
    });
    expect(out).toContain('import { defineCommerce } from "steelyard"');
    expect(out).toContain("export default");
    expect(out).toContain('"Acme"');
  });

  it("env addition contains STRIPE_SECRET_KEY hint only when tier=B", () => {
    expect(renderEnvLocalAddition("a")).toBe("");
    expect(renderEnvLocalAddition("b")).toContain("STRIPE_SECRET_KEY=");
  });
});
