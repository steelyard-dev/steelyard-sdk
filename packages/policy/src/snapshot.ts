import { createHash } from "node:crypto";
import type { ResolvedPolicy } from "./schema/load.js";

export interface PolicySnapshot {
  policy_hash: string;
  policy: ResolvedPolicy;
  yaml_bytes: string;
}

export class PolicySnapshotStore {
  private readonly snapshots = new Map<string, PolicySnapshot>();
  private readonly refcounts = new Map<string, number>();
  private currentHash: string | undefined;

  add(policy: ResolvedPolicy, yaml: string): PolicySnapshot {
    const policy_hash = policyHash(policy);
    if (!this.snapshots.has(policy_hash)) {
      this.snapshots.set(policy_hash, { policy_hash, policy, yaml_bytes: yaml });
      this.refcounts.set(policy_hash, 0);
    }
    this.currentHash = policy_hash;
    return this.getCurrent();
  }

  get(policy_hash: string): PolicySnapshot | undefined {
    return this.snapshots.get(policy_hash);
  }

  getCurrent(): PolicySnapshot {
    if (!this.currentHash) throw new Error("no policy loaded");
    const snapshot = this.snapshots.get(this.currentHash);
    if (!snapshot) throw new Error(`current policy snapshot missing: ${this.currentHash}`);
    return snapshot;
  }

  retain(policy_hash: string): void {
    const refs = this.refcounts.get(policy_hash);
    if (refs === undefined) throw new Error(`unknown snapshot ${policy_hash}`);
    this.refcounts.set(policy_hash, refs + 1);
  }

  release(policy_hash: string): void {
    const refs = this.refcounts.get(policy_hash);
    if (!refs) throw new Error(`release without retain: ${policy_hash}`);
    this.refcounts.set(policy_hash, refs - 1);
  }

  gc(): string[] {
    const dropped: string[] = [];
    for (const [hash, refs] of this.refcounts.entries()) {
      if (refs === 0 && hash !== this.currentHash) {
        this.snapshots.delete(hash);
        this.refcounts.delete(hash);
        dropped.push(hash);
      }
    }
    return dropped;
  }
}

export function policyHash(policy: ResolvedPolicy): string {
  return `sha256:${createHash("sha256").update(canonicalJson(policy)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}
