# @steelyard/next

Next.js adapter for Steelyard. Lets you serve the four read surfaces
(`/.well-known/commerce.json`, `/mcp`, `/acp/feed`, `/.well-known/ucp`) from
inside any Next.js 14+ App Router or Pages Router app.

```sh
npm install @steelyard/next
# or scaffold everything at once:
npx steelyard init
```

## App Router

```ts
// app/mcp/route.ts
import { createCommerceRoutes } from "@steelyard/next";
import manifest from "@/commerce";

const routes = createCommerceRoutes(manifest);
export const GET = routes.mcp;
export const POST = routes.mcp;
```

The four surfaces map to four `route.ts` files. `steelyard init` writes them
for you.

## Pages Router

```ts
// pages/api/mcp.ts
import { toNextApiHandler } from "@steelyard/next";
import { createMcpHttpHandler } from "@steelyard/protocol/mcp";
import manifest from "../../commerce";

export default toNextApiHandler(createMcpHttpHandler(manifest));
```

## Dev inspector

`steelyard init` optionally writes a dev-only page at
`app/(steelyard)/steelyard/page.tsx`. It is owned by your repo: edit, gitignore,
or delete freely.
