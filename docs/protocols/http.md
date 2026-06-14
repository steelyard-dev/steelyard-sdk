# HTTP API

The v0.4 HTTP API exposes the same public read-side commerce data as the
well-known manifest, but through small resource endpoints under `/commerce`.
It is intended for clients that want ordinary HTTP fetches rather than MCP,
ACP, or UCP protocol bindings.

```ts
import { createHttpApiHandler } from "@steelyard/protocol/http";

const commerce = createHttpApiHandler(manifest);
```

The default prefix is `/commerce`. You can override it with
`createHttpApiHandler(manifest, { prefix: "/catalog" })`, but `/commerce` is the
default used by Steelyard examples and docs.

## Endpoints

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/commerce` | Links to products, policies, and capabilities. |
| `GET` | `/commerce/products` | Paginated offer list. |
| `GET` | `/commerce/products?id=<id>` | One offer. |
| `GET` | `/commerce/policies` | Policy list. |
| `GET` | `/commerce/policies?id=<id>` | One policy. |
| `GET` | `/commerce/capabilities` | Peer protocol URLs. |
| `HEAD` | Any route above | Same headers, empty body. |

`OPTIONS` is supported when CORS is configured on the handler.

## Products

```text
GET /commerce/products?query=espresso&limit=10&offset=0
GET /commerce/products?id=double
```

Search is a case-insensitive substring match over the same fields MCP
`list_offers` uses: `id`, `title`, `description`, `categories`, and stringified
attribute values. `category=<value>` applies an exact category filter.

The default `limit` is the catalog length and the maximum accepted limit is
1000.

## Policies

```text
GET /commerce/policies
GET /commerce/policies?id=returns
```

Steelyard v0.4 adds optional `Policy.id` to the core schema. If a policy omits
an id, `commerceManifest()` derives a stable id from `type`, suffixing duplicate
types as needed. Explicit duplicate ids are rejected.

## Errors

The HTTP API uses a small v0.4 error envelope:

```json
{
  "error": {
    "code": "not_found",
    "message": "Unknown product id: missing"
  }
}
```

Recognized routes with unsupported verbs return `405`. Unknown paths under
`/commerce`, including mutation-looking paths such as `/commerce/orders`,
return `404`.

## Read-only

There are no purchase, cart, order, wallet, checkout, webhook, or payment
mutation endpoints under `/commerce/*` in v0.4. ACP and UCP checkout remain on
their v0.3 protocol-specific checkout routes.

## Verification

Every response body is validated against the authored schemas in
`packages/core/spec/http/0.1/`. The coffee-shop example also scans common
mutation-looking `/commerce/*` paths in CI to ensure they are not mounted.
