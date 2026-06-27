import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { toNextApiHandler } from "./to-next-api-handler.js";

describe("toNextApiHandler", () => {
  it("invokes the underlying node handler with the same args", async () => {
    let called = false;
    const wrapped = toNextApiHandler((req, res) => {
      called = true;
      res.statusCode = 201;
      res.end();
    });
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/x", headers: {} });
    const res = {
      statusCode: 200,
      ended: false,
      end() {
        this.ended = true;
      }
    };
    wrapped(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(called).toBe(true);
    expect(res.statusCode).toBe(201);
    expect(res.ended).toBe(true);
  });
});
