// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { defaultClock, type Clock, type EcJwk, type Manifest } from "@steelyard/core";
import {
  parseUcpAgentProfileUrl,
  signUcpResponse,
  verifyUcpRequest,
  type UcpRequestVerificationFailureReason,
  type UcpSigningMaterial
} from "../ucp/signatures.js";
import { createMcpServer } from "./server.js";

export interface McpHttpHandlerOptions {
  hms?: {
    enabled: boolean;
    resolveKey: (kid: string, signerProfileUrl: string) => Promise<EcJwk | null>;
  };
  responseSigning?: {
    enabled: boolean;
    signing: UcpSigningMaterial;
  };
  clock?: Clock;
  onUcpAgentMismatch?: (mismatch: McpUcpAgentMismatch) => void;
}

export interface McpUcpAgentMismatch {
  httpProfileUrl: string;
  metaProfileUrl: string;
}

export function createMcpHttpHandler(manifest: Manifest, options: McpHttpHandlerOptions = {}) {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const clock = defaultClock(options.clock);

  return async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let parsedBody: unknown | undefined;
      let rawBody: Uint8Array | undefined;

      if (req.method === "POST" && (options.hms?.enabled || !sessionId || !transports.has(sessionId))) {
        const body = await readBody(req);
        rawBody = body.byteLength === 0 ? undefined : body;
        parsedBody = parseJsonBody(body);
        warnOnUcpAgentMismatch(req, parsedBody, options);
      } else {
        warnOnUcpAgentMismatch(req, undefined, options);
      }

      if (options.hms?.enabled) {
        const verification = await verifyUcpRequest({
          method: req.method ?? "GET",
          url: requestUrl(req),
          headers: headersRecord(req.headers),
          body: rawBody,
          resolveKey: options.hms.resolveKey,
          now: clock()
        });
        if (!verification.ok) {
          sendMcpSignatureError(res, verification.reason, verification.detail);
          return;
        }
      }

      if (sessionId && transports.has(sessionId)) {
        await handleTransportRequest(transports.get(sessionId)!, req, res, parsedBody, options, clock);
        return;
      }

      if (req.method === "POST") {
        if (isInitializeRequest(parsedBody)) {
          let transport: StreamableHTTPServerTransport;
          transport = new StreamableHTTPServerTransport({
            enableJsonResponse: options.responseSigning?.enabled === true,
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            }
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await createMcpServer(manifest).connect(transport);
          await handleTransportRequest(transport, req, res, parsedBody, options, clock);
          return;
        }
      }

      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or unknown mcp-session-id" }));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  };
}

async function handleTransportRequest(
  transport: StreamableHTTPServerTransport,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  options: McpHttpHandlerOptions,
  clock: Clock
): Promise<void> {
  if (options.responseSigning?.enabled !== true) {
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  const buffered = bufferResponseForSigning(res, options.responseSigning.signing, clock);
  await transport.handleRequest(req, buffered.response, parsedBody);
  await buffered.done();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function warnOnUcpAgentMismatch(req: IncomingMessage, body: unknown, options: McpHttpHandlerOptions): void {
  if (!options.onUcpAgentMismatch) return;
  const httpProfileUrl = parseUcpAgentProfileUrl(singleHeader(req.headers["ucp-agent"]) ?? "");
  const metaProfileUrl = extractMetaUcpAgentProfileUrl(body);
  if (httpProfileUrl && metaProfileUrl && httpProfileUrl !== metaProfileUrl) {
    options.onUcpAgentMismatch({ httpProfileUrl, metaProfileUrl });
  }
}

function extractMetaUcpAgentProfileUrl(body: unknown): string | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const params = (message as { params?: unknown }).params;
    if (!params || typeof params !== "object") continue;
    const args = (params as { arguments?: unknown }).arguments;
    if (!args || typeof args !== "object") continue;
    const meta = (args as { meta?: unknown }).meta;
    if (!meta || typeof meta !== "object") continue;
    const ucpAgent = (meta as { "ucp-agent"?: unknown })["ucp-agent"];
    if (!ucpAgent || typeof ucpAgent !== "object") continue;
    const profile = (ucpAgent as { profile?: unknown }).profile;
    if (typeof profile === "string" && profile) return profile;
  }
  return null;
}

function requestUrl(req: IncomingMessage): URL {
  const host = singleHeader(req.headers.host) ?? "localhost";
  const forwardedProto = singleHeader(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  const protocol = forwardedProto || (isEncrypted(req) ? "https" : "http");
  return new URL(req.url ?? "/", `${protocol}://${host}`);
}

function isEncrypted(req: IncomingMessage): boolean {
  return "encrypted" in req.socket && req.socket.encrypted === true;
}

function headersRecord(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const header = singleHeader(value);
    if (header !== undefined) out[name] = header;
  }
  return out;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function sendMcpSignatureError(
  res: ServerResponse,
  reason: UcpRequestVerificationFailureReason,
  detail: string | undefined
): void {
  const status = httpStatusForSignatureError(reason);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: mcpCodeForSignatureError(reason),
      message: reason,
      data: detail ? { ucp_code: reason, detail } : { ucp_code: reason }
    },
    id: null
  }));
}

function httpStatusForSignatureError(reason: UcpRequestVerificationFailureReason): number {
  return reason === "digest_mismatch" || reason === "algorithm_unsupported" ? 400 : 401;
}

function mcpCodeForSignatureError(reason: UcpRequestVerificationFailureReason): number {
  return reason === "digest_mismatch" || reason === "algorithm_unsupported" ? -32600 : -32000;
}

function bufferResponseForSigning(
  res: ServerResponse,
  signing: UcpSigningMaterial,
  clock: Clock
): { response: ServerResponse; done: () => Promise<void> } {
  const chunks: Buffer[] = [];
  const headers = new Map<string, OutgoingHttpHeader>();
  let statusCode = res.statusCode || 200;
  let statusMessage = res.statusMessage;
  let finished: Promise<void> | undefined;

  const original = {
    end: res.end.bind(res),
    getHeader: res.getHeader.bind(res),
    getHeaderNames: res.getHeaderNames.bind(res),
    getHeaders: res.getHeaders.bind(res),
    hasHeader: res.hasHeader.bind(res),
    removeHeader: res.removeHeader.bind(res),
    setHeader: res.setHeader.bind(res),
    write: res.write.bind(res),
    writeHead: res.writeHead.bind(res)
  };

  const response = res as ServerResponse;
  response.setHeader = ((name: string, value: number | string | readonly string[]) => {
    headers.set(name.toLowerCase(), value as OutgoingHttpHeader);
    return response;
  }) as typeof res.setHeader;
  response.getHeader = ((name: string) => headers.get(name.toLowerCase()) ?? original.getHeader(name)) as typeof res.getHeader;
  response.getHeaderNames = (() => Array.from(new Set([...original.getHeaderNames(), ...headers.keys()]))) as typeof res.getHeaderNames;
  response.getHeaders = (() => ({ ...original.getHeaders(), ...Object.fromEntries(headers) })) as typeof res.getHeaders;
  response.hasHeader = ((name: string) => headers.has(name.toLowerCase()) || original.hasHeader(name)) as typeof res.hasHeader;
  response.removeHeader = ((name: string) => {
    headers.delete(name.toLowerCase());
    original.removeHeader(name);
  }) as typeof res.removeHeader;
  response.writeHead = ((code: number, reasonOrHeaders?: string | OutgoingHttpHeaders, maybeHeaders?: OutgoingHttpHeaders) => {
    statusCode = code;
    if (typeof reasonOrHeaders === "string") {
      statusMessage = reasonOrHeaders;
      mergeOutgoingHeaders(headers, maybeHeaders);
    } else {
      mergeOutgoingHeaders(headers, reasonOrHeaders);
    }
    return response;
  }) as typeof res.writeHead;
  response.write = ((chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error) => void), callback?: (error?: Error) => void) => {
    appendChunk(chunks, chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (cb) queueMicrotask(() => cb());
    return true;
  }) as typeof res.write;
  response.end = ((chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
    appendChunk(chunks, chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    finished = flushSignedResponse({ original, headers, chunks, statusCode, statusMessage, signing, clock, callback: cb });
    return response;
  }) as typeof res.end;

  return {
    response,
    done: async () => {
      if (finished) await finished;
    }
  };
}

async function flushSignedResponse(args: {
  original: Pick<ServerResponse, "end" | "setHeader" | "writeHead">;
  headers: Map<string, OutgoingHttpHeader>;
  chunks: Buffer[];
  statusCode: number;
  statusMessage: string;
  signing: UcpSigningMaterial;
  clock: Clock;
  callback?: () => void;
}): Promise<void> {
  const body = Buffer.concat(args.chunks);
  const headerRecord = outgoingHeadersRecord(args.headers);
  const signed = await signUcpResponse({
    status: args.statusCode,
    headers: headerRecord,
    body: body.byteLength === 0 ? undefined : body,
    signing: args.signing,
    now: args.clock()
  });
  for (const [name, value] of Object.entries(signed.headers)) {
    args.original.setHeader(name, value);
  }
  args.original.writeHead(args.statusCode, args.statusMessage);
  args.original.end(body, args.callback);
}

function mergeOutgoingHeaders(target: Map<string, OutgoingHttpHeader>, headers: OutgoingHttpHeaders | undefined): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) target.set(name.toLowerCase(), value);
  }
}

function appendChunk(chunks: Buffer[], chunk: unknown, encoding: BufferEncoding = "utf8"): void {
  if (chunk === undefined || chunk === null) return;
  chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk as Uint8Array));
}

function outgoingHeadersRecord(headers: Map<string, OutgoingHttpHeader>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (Array.isArray(value)) out[name] = value.join(", ");
    else out[name] = String(value);
  }
  return out;
}
