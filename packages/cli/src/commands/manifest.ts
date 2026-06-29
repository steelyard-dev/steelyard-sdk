// Copyright (c) Steelyard contributors. MIT License.
import {
  commerceManifest,
  type CommerceManifestPeer,
  type Manifest,
  type PeerName
} from "@steelyard-dev/core";
import type { CommandResult, CliIO } from "../io.js";
import { writeLine } from "../io.js";
import {
  envClock,
  loadJsonSource,
  SourceError,
  validateGeneratedAt,
  type SourceOptions
} from "../source.js";
import { handleCommandError } from "./validate.js";

export interface ManifestOptions extends SourceOptions {
  json?: boolean;
  pretty?: boolean;
  peer?: string | string[];
  protocolVersion?: string | string[];
  generatedAt?: string;
}

const PEER_NAMES = new Set<PeerName>(["acp", "ucp", "mcp", "http"]);

export async function manifestCommand(source: string | undefined, opts: ManifestOptions, io: CliIO): Promise<CommandResult> {
  if (!source) {
    writeLine(io.stderr, "usage: steelyard manifest <source>");
    return { code: 4 };
  }

  try {
    const manifest = (await loadJsonSource(source, opts, io)) as Manifest;
    const peers = parsePeers(opts.peer, opts.protocolVersion);
    const generatedAt = validateGeneratedAt(opts.generatedAt) ?? envClock(io);
    const doc = commerceManifest(manifest, { peers, generatedAt });
    const json = JSON.stringify(opts.json ? { doc, warnings: [] } : doc, null, opts.pretty ? 2 : 0);
    writeLine(io.stdout, json);
    return { code: 0 };
  } catch (error) {
    return handleCommandError(error, io, opts.json);
  }
}

export function parsePeers(
  peerFlags: string | string[] | undefined,
  versionFlags: string | string[] | undefined
): Partial<Record<PeerName, CommerceManifestPeer>> | undefined {
  const peers = parsePairs(peerFlags, "--peer");
  const versions = parsePairs(versionFlags, "--protocol-version");
  const out: Partial<Record<PeerName, CommerceManifestPeer>> = {};

  for (const [name, url] of peers) {
    const peerName = parsePeerName(name);
    const protocolVersion = versions.get(peerName);
    if (!protocolVersion) {
      throw new SourceError(4, `--peer ${peerName}=... requires --protocol-version ${peerName}=...`);
    }
    out[peerName] = { url, protocol_version: protocolVersion };
  }

  for (const name of versions.keys()) {
    parsePeerName(name);
  }

  return Object.keys(out).length ? out : undefined;
}

function parsePairs(value: string | string[] | undefined, flag: string): Map<string, string> {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const pairs = new Map<string, string>();
  for (const item of values) {
    const separator = item.indexOf("=");
    if (separator <= 0) throw new SourceError(4, `${flag} expects <name>=<value>`);
    const key = item.slice(0, separator);
    const pairValue = item.slice(separator + 1);
    if (!pairValue) throw new SourceError(4, `${flag} expects <name>=<value>`);
    pairs.set(key, pairValue);
  }
  return pairs;
}

function parsePeerName(value: string): PeerName {
  if (PEER_NAMES.has(value as PeerName)) return value as PeerName;
  throw new SourceError(4, `unknown peer name: ${value}`);
}
