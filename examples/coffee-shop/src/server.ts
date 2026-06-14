import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildAcpFeed } from "@steelyard/protocol/acp";
import { createMcpHttpHandler } from "@steelyard/protocol/mcp";
import { createUcpHandler } from "@steelyard/protocol/ucp";
import { coffeeShopManifest } from "./catalog.js";

export function createCoffeeShopHandler() {
  const mcp = createMcpHttpHandler(coffeeShopManifest);
  const ucp = createUcpHandler(coffeeShopManifest);

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.url?.startsWith("/mcp")) {
      void mcp(req, res);
      return;
    }
    if (req.url?.startsWith("/acp/feed")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ...buildAcpFeed(coffeeShopManifest),
        merchant: { domain: "coffee.example" },
        capabilities: { services: ["read"] }
      }));
      return;
    }
    void ucp(req, res);
  };
}

export function createCoffeeShopServer() {
  return createServer(createCoffeeShopHandler());
}
