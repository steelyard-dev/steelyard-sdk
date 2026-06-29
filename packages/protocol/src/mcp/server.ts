// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { Manifest } from "@steelyard-dev/core";
import { COMMERCE_CAPABILITY, COMMERCE_EXTENSION_KEY } from "./capability.js";
import { getOffer, listOffers, type ToolResponse } from "./tools.js";

const TOOL_INPUT_SCHEMAS = {
  list_offers: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional free-text query." },
      limit: { type: "number", minimum: 1 }
    }
  },
  get_offer: {
    type: "object",
    properties: {
      id: { type: "string", description: "Offer id." }
    },
    required: ["id"]
  }
} as const;

export function createMcpServer(manifest: Manifest): Server {
  const server = new Server(serverInfo(manifest), {
    capabilities: serverCapabilities(),
    instructions: `${manifest.identity.name} exposes a read-only commerce catalog.`
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_offers",
        description: `List ${manifest.identity.name}'s offers, optionally filtered by query.`,
        inputSchema: TOOL_INPUT_SCHEMAS.list_offers
      },
      {
        name: "get_offer",
        description: `Get one ${manifest.identity.name} offer by id.`,
        inputSchema: TOOL_INPUT_SCHEMAS.get_offer
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = callTool(manifest, request.params.name, args);
    if (!result.ok) {
      return { isError: true, content: [{ type: "text", text: result.error }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result.content) }] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "commerce://manifest",
        name: "Commerce manifest",
        mimeType: "application/json"
      },
      {
        uri: "commerce://policies",
        name: "Commerce policies",
        mimeType: "application/json"
      }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "commerce://manifest") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(manifest)
          }
        ]
      };
    }
    if (request.params.uri === "commerce://policies") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(manifest.policies)
          }
        ]
      };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
  });

  return server;
}

function callTool(manifest: Manifest, name: string, args: Record<string, unknown>): ToolResponse {
  switch (name) {
    case "list_offers":
      return listOffers(manifest, {
        query: args.query === undefined ? undefined : String(args.query),
        limit: typeof args.limit === "number" ? args.limit : undefined
      });
    case "get_offer":
      return getOffer(manifest, { id: String(args.id ?? "") });
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

function serverInfo(manifest: Manifest): Implementation {
  return {
    name: `steelyard:${manifest.identity.name}`,
    version: "0.1.0"
  };
}

function serverCapabilities(): ServerCapabilities {
  return {
    tools: {},
    resources: {},
    extensions: {
      [COMMERCE_EXTENSION_KEY]: { commerce: COMMERCE_CAPABILITY }
    }
  };
}
