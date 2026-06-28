import { describe, expect, it } from "vitest";
import { loadPolicyFromString } from "../src/schema/load.js";
import { PolicySnapshotStore } from "../src/snapshot.js";

const POLICY_A = `
version: 2026-06-27
rules:
  - name: deny
    do: deny
`;

const POLICY_A_REFORMATTED = `version: 2026-06-27
rules: [{ name: deny, do: deny }]
`;

const POLICY_B = `
version: 2026-06-27
rules:
  - name: deny-b
    do: deny
`;

describe("PolicySnapshotStore", () => {
  it("hashes equivalent normalized policies the same", () => {
    const store = new PolicySnapshotStore();
    const a = store.add(loadPolicyFromString(POLICY_A).policy, POLICY_A);
    const a2 = store.add(loadPolicyFromString(POLICY_A_REFORMATTED).policy, POLICY_A_REFORMATTED);
    expect(a.policy_hash).toBe(a2.policy_hash);
  });

  it("hashes different policies differently", () => {
    const store = new PolicySnapshotStore();
    const a = store.add(loadPolicyFromString(POLICY_A).policy, POLICY_A);
    const b = store.add(loadPolicyFromString(POLICY_B).policy, POLICY_B);
    expect(a.policy_hash).not.toBe(b.policy_hash);
  });

  it("getCurrent returns the most recently added snapshot", () => {
    const store = new PolicySnapshotStore();
    store.add(loadPolicyFromString(POLICY_A).policy, POLICY_A);
    const b = store.add(loadPolicyFromString(POLICY_B).policy, POLICY_B);
    expect(store.getCurrent().policy_hash).toBe(b.policy_hash);
  });

  it("retain and release tracks references and gc drops non-current snapshots with zero refs", () => {
    const store = new PolicySnapshotStore();
    const a = store.add(loadPolicyFromString(POLICY_A).policy, POLICY_A);
    store.retain(a.policy_hash);
    store.add(loadPolicyFromString(POLICY_B).policy, POLICY_B);
    expect(store.gc()).toEqual([]);
    store.release(a.policy_hash);
    expect(store.gc()).toEqual([a.policy_hash]);
  });

  it("rejects reference operations on unknown or unretained snapshots", () => {
    const store = new PolicySnapshotStore();
    expect(() => store.getCurrent()).toThrow(/no policy loaded/);
    expect(() => store.retain("sha256:missing")).toThrow(/unknown snapshot/);
    expect(() => store.release("sha256:missing")).toThrow(/release without retain/);
    const a = store.add(loadPolicyFromString(POLICY_A).policy, POLICY_A);
    expect(() => store.release(a.policy_hash)).toThrow(/release without retain/);
  });
});
