// Copyright (c) Steelyard contributors. MIT License.
//
// toNextHandler — adapt a Node RequestListener into a Next.js App Router handler.
//
// The protocol handlers in @steelyard/protocol are Node `RequestListener`s
// (req: IncomingMessage, res: ServerResponse) => void. App Router routes are
// (req: Request) => Promise<Response>. This adapter mocks the minimum surface
// of IncomingMessage and ServerResponse, invokes the handler, and assembles a
// Response from what the handler wrote.
//
// Mock surface kept intentionally small: only what current handlers use.

import { Readable } from "node:stream";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export type NextRouteHandler = (req: Request) => Promise<Response>;

interface MockRes {
  statusCode: number;
  statusMessage?: string;
  headersSent: boolean;
  end(chunk?: unknown): void;
  write(chunk: unknown): boolean;
  setHeader(name: string, value: string | string[] | number): void;
  getHeader(name: string): string | string[] | number | undefined;
  removeHeader(name: string): void;
  writeHead(statusCode: number, headers?: Record<string, string | string[] | number>): MockRes;
}

export function toNextHandler(node: RequestListener): NextRouteHandler {
  return async (request) => {
    const url = new URL(request.url);
    const pathAndQuery = `${url.pathname}${url.search}`;

    const bodyBuffer = ["GET", "HEAD"].includes(request.method)
      ? Buffer.alloc(0)
      : Buffer.from(await request.arrayBuffer());

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const incomingStream = Readable.from(bodyBuffer.length ? [bodyBuffer] : []);
    const req = Object.assign(incomingStream, {
      method: request.method,
      url: pathAndQuery,
      headers,
      httpVersion: "1.1",
      httpVersionMajor: 1,
      httpVersionMinor: 1
    }) as unknown as IncomingMessage;

    const chunks: Buffer[] = [];
    const responseHeaders: Record<string, string | string[] | number> = {};
    let status = 200;
    let resolved = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });

    const res: MockRes = {
      statusCode: 200,
      headersSent: false,
      end(chunk?: unknown) {
        if (chunk !== undefined) {
          chunks.push(toBuffer(chunk));
        }
        status = this.statusCode;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      },
      write(chunk: unknown) {
        chunks.push(toBuffer(chunk));
        return true;
      },
      setHeader(name, value) {
        responseHeaders[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return responseHeaders[name.toLowerCase()];
      },
      removeHeader(name) {
        delete responseHeaders[name.toLowerCase()];
      },
      writeHead(statusCode, hdrs) {
        this.statusCode = statusCode;
        if (hdrs) {
          for (const [name, value] of Object.entries(hdrs)) {
            this.setHeader(name, value);
          }
        }
        this.headersSent = true;
        return this;
      }
    };

    try {
      node(req, res as unknown as ServerResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return new Response(message, { status: 500 });
    }

    await done;

    const responseInit: ResponseInit = {
      status,
      headers: normalizeHeaders(responseHeaders)
    };
    // Status codes 101, 204, 205, 304 must have a null body per the Fetch spec.
    const nullBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
    const body = nullBodyStatus ? null : Buffer.concat(chunks);
    return new Response(body, responseInit);
  };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.from(String(chunk), "utf8");
}

function normalizeHeaders(raw: Record<string, string | string[] | number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      out[name] = value.join(", ");
    } else {
      out[name] = String(value);
    }
  }
  return out;
}
