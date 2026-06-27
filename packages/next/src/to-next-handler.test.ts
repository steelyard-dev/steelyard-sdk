import { describe, expect, it } from "vitest";
import type { RequestListener } from "node:http";
import { toNextHandler } from "./to-next-handler.js";

const echoJson: RequestListener = (req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"] ?? null,
        body
      })
    );
  });
};

describe("toNextHandler", () => {
  it("forwards method, path, headers, and JSON body to the node handler", async () => {
    const handler = toNextHandler(echoJson);
    const res = await handler(
      new Request("https://shop.example/mcp?q=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}'
      })
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.method).toBe("POST");
    expect(payload.url).toBe("/mcp?q=1");
    expect(payload.contentType).toBe("application/json");
    expect(payload.body).toBe('{"hello":"world"}');
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("propagates non-200 status codes and headers", async () => {
    const handler = toNextHandler((_req, res) => {
      res.statusCode = 404;
      res.setHeader("x-custom", "yes");
      res.end("nope");
    });
    const res = await handler(new Request("https://shop.example/missing"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(await res.text()).toBe("nope");
  });

  it("strips the origin from req.url so handlers see a path", async () => {
    let seenUrl = "";
    const handler = toNextHandler((req, res) => {
      seenUrl = req.url ?? "";
      res.statusCode = 204;
      res.end();
    });
    await handler(new Request("https://shop.example/.well-known/commerce.json"));
    expect(seenUrl).toBe("/.well-known/commerce.json");
  });

  it("returns 500 when the handler throws synchronously", async () => {
    const handler = toNextHandler(() => {
      throw new Error("boom");
    });
    const res = await handler(new Request("https://shop.example/x"));
    expect(res.status).toBe(500);
  });
});
