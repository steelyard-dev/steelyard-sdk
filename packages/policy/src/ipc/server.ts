import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  CallerTokenManager,
  checkPeerCredentials,
  enforceSocketPathSecurity,
  type PeerCredentialCheck
} from "./auth.js";
import { isRpcMethodName, type JsonRpcId, type RpcHandlers, type RpcParams } from "./methods.js";

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32000;
const ERR_UNAUTHENTICATED = -32001;
const ERR_PEER_REJECTED = -32002;

export interface IpcServerOpts {
  socketPath: string;
  tokenPath: string;
  handlers: RpcHandlers;
  peerCheck?: (socket: Socket) => PeerCredentialCheck;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: RpcParams;
}

interface RpcError {
  code: number;
  message: string;
}

export class IpcServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly tokens: CallerTokenManager;

  constructor(private readonly opts: IpcServerOpts) {
    this.tokens = new CallerTokenManager(opts.tokenPath);
  }

  async start(): Promise<this> {
    if (this.server) throw new Error("IPC server already started");
    mkdirSync(dirname(this.opts.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
    this.tokens.ensure();

    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.opts.socketPath);
    });
    enforceSocketPathSecurity(this.opts.socketPath);
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
  }

  callerToken(): string {
    return this.tokens.ensure();
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));

    const peer = this.opts.peerCheck ? this.opts.peerCheck(socket) : checkPeerCredentials(socket);
    if (!peer.ok) {
      socket.write(serializeResponse({ jsonrpc: "2.0", id: null, error: { code: ERR_PEER_REJECTED, message: peer.reason } }));
      socket.end();
      return;
    }

    let buffer = "";
    let queue = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        queue = queue.then(() => this.handleLine(socket, line)).catch((error: unknown) => {
          socket.write(
            serializeResponse({
              jsonrpc: "2.0",
              id: null,
              error: { code: ERR_INTERNAL, message: error instanceof Error ? error.message : "internal error" }
            })
          );
        });
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    const request = parseRequest(line);
    if ("error" in request) {
      socket.write(serializeResponse({ jsonrpc: "2.0", id: request.id, error: request.error }));
      return;
    }

    const params = request.params ?? {};
    const callerToken = typeof params.caller_token === "string" ? params.caller_token : "";
    if (!this.tokens.verify(callerToken)) {
      socket.write(
        serializeResponse({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: ERR_UNAUTHENTICATED, message: "unauthenticated" }
        })
      );
      return;
    }

    if (!isRpcMethodName(request.method)) {
      socket.write(
        serializeResponse({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: ERR_METHOD_NOT_FOUND, message: "method not found" }
        })
      );
      return;
    }

    const handler = this.opts.handlers[request.method];
    if (!handler) {
      socket.write(
        serializeResponse({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: ERR_METHOD_NOT_FOUND, message: "method not found" }
        })
      );
      return;
    }

    try {
      const result = await handler(params);
      socket.write(serializeResponse({ jsonrpc: "2.0", id: request.id ?? null, result }));
    } catch (error) {
      socket.write(
        serializeResponse({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: ERR_INTERNAL, message: error instanceof Error ? error.message : "internal error" }
        })
      );
    }
  }
}

function parseRequest(line: string): JsonRpcRequest | { id: JsonRpcId; error: RpcError } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { id: null, error: { code: ERR_PARSE, message: "parse error" } };
  }

  if (!isRecord(value)) {
    return { id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request" } };
  }
  const id = isJsonRpcId(value.id) ? value.id : null;
  if (value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return { id, error: { code: ERR_INVALID_REQUEST, message: "invalid request" } };
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    return { id, error: { code: ERR_INVALID_REQUEST, message: "invalid params" } };
  }
  return {
    jsonrpc: "2.0",
    id,
    method: value.method,
    params: value.params as RpcParams | undefined
  };
}

function serializeResponse(response: Record<string, unknown>): string {
  return `${JSON.stringify(response, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === undefined || value === null || typeof value === "string" || typeof value === "number";
}
