// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Manifest } from "@steelyard/core";
import { createMcpServer } from "./server.js";

export function createMcpHttpHandler(manifest: Manifest) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (isInitializeRequest(body)) {
          let transport: StreamableHTTPServerTransport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            }
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await createMcpServer(manifest).connect(transport);
          await transport.handleRequest(req, res, body);
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}
