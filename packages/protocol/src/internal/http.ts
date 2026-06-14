// Copyright (c) Steelyard contributors. MIT License.
import type { IncomingMessage, ServerResponse } from "node:http";

export type CorsOpts =
  | undefined
  | {
      origin: "*" | string | string[];
      methods?: string[];
      headers?: string[];
      maxAge?: number;
    };

export interface ErrorEnvelope {
  error: {
    code: "not_found" | "method_not_allowed" | "bad_request" | "internal_error";
    message: string;
    details?: unknown;
  };
}

export type Fallthrough = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "localhost";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return new URL(req.url ?? "/", `${Array.isArray(proto) ? proto[0] : proto}://${host}`);
}

export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  opts: { cors?: CorsOpts; headers?: Record<string, string | number>; headOnly?: boolean } = {}
): void {
  const raw = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
    ...corsHeaders(req, opts.cors),
    ...opts.headers
  };
  res.writeHead(status, headers);
  res.end(opts.headOnly || req.method === "HEAD" ? undefined : raw);
}

export function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  code: ErrorEnvelope["error"]["code"],
  message: string,
  opts: { cors?: CorsOpts; details?: unknown; headers?: Record<string, string | number> } = {}
): void {
  const body: ErrorEnvelope = {
    error: opts.details === undefined ? { code, message } : { code, message, details: opts.details }
  };
  sendJson(req, res, status, body, { cors: opts.cors, headers: opts.headers });
}

export function sendOptions(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Exclude<CorsOpts, undefined>,
  defaultMethods: string[]
): void {
  res.writeHead(204, corsHeaders(req, cors, defaultMethods));
  res.end();
}

export async function invokeFallthrough(
  req: IncomingMessage,
  res: ServerResponse,
  fallthrough?: Fallthrough
): Promise<void> {
  if (!fallthrough) {
    sendError(req, res, 404, "not_found", "Not found");
    return;
  }

  try {
    await fallthrough(req, res);
  } catch (error) {
    console.error("steelyard protocol fallthrough failed", {
      error: error instanceof Error ? error.message : String(error),
      path: req.url
    });
    if (!res.headersSent) {
      sendError(req, res, 500, "internal_error", "Internal error");
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

export function corsHeaders(
  req: IncomingMessage,
  cors?: CorsOpts,
  defaultMethods: string[] = ["GET", "HEAD", "OPTIONS"]
): Record<string, string | number> {
  if (!cors) return {};

  const origin = resolveCorsOrigin(req, cors.origin);
  const requestHeaders = req.headers["access-control-request-headers"];
  const headers = cors.headers ?? (requestHeaders ? [String(requestHeaders)] : ["content-type"]);
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": (cors.methods ?? defaultMethods).join(", "),
    "access-control-allow-headers": headers.join(", "),
    ...(cors.maxAge === undefined ? {} : { "access-control-max-age": cors.maxAge })
  };
}

function resolveCorsOrigin(req: IncomingMessage, origin: Exclude<CorsOpts, undefined>["origin"]): string {
  if (origin === "*") return "*";
  if (typeof origin === "string") return origin;

  const requestOrigin = req.headers.origin;
  if (typeof requestOrigin === "string" && origin.includes(requestOrigin)) return requestOrigin;
  return origin[0] ?? "null";
}
