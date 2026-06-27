// Copyright (c) Steelyard contributors. MIT License.
//
// toNextApiHandler — Pages Router API route adapter. Pages-Router routes already
// receive Node-shaped IncomingMessage / ServerResponse, so this is essentially
// an identity wrapper today. Kept as a named export so we can evolve it (logging,
// instrumentation, body parsing alignment) without breaking users.

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export type NextApiRouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function toNextApiHandler(node: RequestListener): NextApiRouteHandler {
  return (req, res) => {
    node(req, res);
  };
}
