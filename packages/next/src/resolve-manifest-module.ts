// Copyright (c) Steelyard contributors. MIT License.
//
// resolveManifestModule — unwrap the user's `commerce.ts` default export.
//
// `commerce.ts` can export the manifest directly, a function returning the
// manifest, or an async function returning a Promise<manifest> (so users can
// pull offers from a DB). This helper handles all three uniformly so each
// generated `route.ts` stays a one-liner instead of duplicating an unwrap
// helper into every user repo.

import type { Manifest } from "@steelyard/core";

type MaybeFactory<T> = T | (() => T) | (() => Promise<T>);

export async function resolveManifestModule(mod: unknown): Promise<Manifest> {
  const value = (mod as { default: unknown }).default as MaybeFactory<Manifest>;
  return typeof value === "function"
    ? await (value as () => Promise<Manifest> | Manifest)()
    : value;
}
