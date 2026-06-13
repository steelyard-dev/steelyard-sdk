import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAcpFeedHandler } from "@steelyard/acp";
import { createMcpHttpHandler } from "@steelyard/mcp";
import { createUcpHandler } from "@steelyard/ucp";
import { coffeeShopManifest } from "./catalog.js";

export function createCoffeeShopHandler() {
  const mcp = createMcpHttpHandler(coffeeShopManifest);
  const acp = createAcpFeedHandler(coffeeShopManifest);
  const ucp = createUcpHandler(coffeeShopManifest);

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.url?.startsWith("/mcp")) {
      void mcp(req, res);
      return;
    }
    if (req.url?.startsWith("/acp/feed")) {
      acp(req, res);
      return;
    }
    void ucp(req, res);
  };
}

export function createCoffeeShopServer() {
  return createServer(createCoffeeShopHandler());
}
