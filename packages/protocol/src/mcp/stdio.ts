// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Manifest } from "@steelyard-dev/core";
import { createMcpServer } from "./server.js";

export async function runMcpStdio(
  manifest: Manifest,
  transport: Transport = new StdioServerTransport()
) {
  const server = createMcpServer(manifest);
  await server.connect(transport);
  return server;
}
