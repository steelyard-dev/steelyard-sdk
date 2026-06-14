# `@steelyard/core/idempotency`

`newIdempotencyKey()` returns an RFC 9562 UUIDv7 string.

Steelyard uses the `uuidv7` package because it is a small focused implementation, provides a direct `uuidv7()` API, and produces time-sortable keys without adding broader UUID machinery.
