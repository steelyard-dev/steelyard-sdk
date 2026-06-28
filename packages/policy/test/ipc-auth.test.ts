import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CallerTokenManager, checkPeerCredentials, enforceSocketPathSecurity } from "../src/ipc/auth.js";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("CallerTokenManager", () => {
  it("creates a token file with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-"));
    const tokenPath = join(dir, "caller.token");

    const mgr = new CallerTokenManager(tokenPath);
    const token = mgr.ensure();

    expect(token).toHaveLength(64);
    expect(mode(tokenPath)).toBe(0o600);
    expect(mgr.verify(token)).toBe(true);
    expect(mgr.verify("bad")).toBe(false);
  });

  it("reuses an existing stable token and narrows its file mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-"));
    const tokenPath = join(dir, "caller.token");
    const token = "a".repeat(64);
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o644 });
    chmodSync(tokenPath, 0o644);

    const mgr = new CallerTokenManager(tokenPath);

    expect(mgr.ensure()).toBe(token);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(token);
    expect(mode(tokenPath)).toBe(0o600);
  });

  it("rejects malformed existing token files", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-"));
    const tokenPath = join(dir, "caller.token");
    writeFileSync(tokenPath, "not-a-token\n", { mode: 0o600 });

    expect(() => new CallerTokenManager(tokenPath).ensure()).toThrow(/32-byte hex token/);
  });
});

describe("IPC socket security helpers", () => {
  it("enforces socket path mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "socket-"));
    const socketPath = join(dir, "policy.sock");
    writeFileSync(socketPath, "");
    chmodSync(socketPath, 0o666);

    const status = enforceSocketPathSecurity(socketPath);

    expect(status.mode).toBe(0o600);
    expect(mode(socketPath)).toBe(0o600);
  });

  it("uses peer credentials when the runtime exposes them", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const good = checkPeerCredentials({ getPeerCredentials: () => ({ uid, gid: 20, pid: 123 }) }, { expected_uid: uid });
    const bad = checkPeerCredentials({ getPeerCredentials: () => ({ uid: uid + 1, gid: 20, pid: 123 }) }, { expected_uid: uid });

    expect(good.ok).toBe(true);
    expect(good.mode).toBe("so_peercred");
    expect(bad.ok).toBe(false);
    expect(bad.mode).toBe("so_peercred");
  });

  it("reports the weaker filesystem fallback when peer credentials are unavailable", () => {
    const result = checkPeerCredentials({});

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("filesystem_fallback");
    expect(result.reason).toContain("caller_token");
  });

  it("can require peer credentials and reject the fallback", () => {
    const result = checkPeerCredentials({}, { allow_filesystem_fallback: false });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("filesystem_fallback");
  });
});
