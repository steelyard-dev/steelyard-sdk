import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IpcServer } from "../src/ipc/server.js";

interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

function rpc(socketPath: string, method: string, params: object, id: string | number = 1): Promise<RpcResult> {
  return rpcRaw(socketPath, { jsonrpc: "2.0", id, method, params });
}

function rpcRaw(socketPath: string, payload: unknown): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.endsWith("\n")) return;
      conn.end();
      try {
        resolve(JSON.parse(buffer) as RpcResult);
      } catch (error) {
        reject(error);
      }
    });
    conn.on("error", reject);
    conn.write(`${typeof payload === "string" ? payload : JSON.stringify(payload)}\n`);
  });
}

function token(path: string): string {
  return readFileSync(path, "utf8").trim();
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("IpcServer", () => {
  it("rejects unauthenticated requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-"));
    const socketPath = join(dir, "policy.sock");
    const srv = await new IpcServer({
      socketPath,
      tokenPath: join(dir, "caller.token"),
      handlers: { capabilities: async () => ({ ok: true }) }
    }).start();

    const response = await rpc(socketPath, "capabilities", {});

    expect(response.error?.code).toBe(-32001);
    await srv.stop();
  });

  it("accepts authenticated capabilities()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-"));
    const socketPath = join(dir, "policy.sock");
    const tokenPath = join(dir, "caller.token");
    const srv = await new IpcServer({
      socketPath,
      tokenPath,
      handlers: { capabilities: async () => ({ rails_enabled: ["virtual_card"], engine_version: "0.0.0" }) }
    }).start();

    const response = await rpc(socketPath, "capabilities", { caller_token: token(tokenPath) });

    expect(response.result).toEqual({ rails_enabled: ["virtual_card"], engine_version: "0.0.0" });
    expect(mode(socketPath)).toBe(0o600);
    await srv.stop();
  });

  it("dispatches every v1 method name to the configured handler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-"));
    const socketPath = join(dir, "policy.sock");
    const srv = await new IpcServer({
      socketPath,
      tokenPath: join(dir, "caller.token"),
      handlers: {
        proposeIntent: async () => ({ ok: "proposeIntent" }),
        getApprovalStatus: async () => ({ ok: "getApprovalStatus" }),
        cancelIntent: async () => ({ ok: "cancelIntent" }),
        revokeCredential: async () => ({ ok: "revokeCredential" }),
        ackSettlement: async () => ({ ok: "ackSettlement" }),
        getPolicySnapshot: async () => ({ ok: "getPolicySnapshot" }),
        capabilities: async () => ({ ok: "capabilities" })
      }
    }).start();
    const caller_token = srv.callerToken();

    await expect(rpc(socketPath, "proposeIntent", { caller_token, idempotency_key: "k" })).resolves.toMatchObject({
      result: { ok: "proposeIntent" }
    });
    await expect(rpc(socketPath, "getApprovalStatus", { caller_token, intent_id: "int_1" })).resolves.toMatchObject({
      result: { ok: "getApprovalStatus" }
    });
    await expect(rpc(socketPath, "cancelIntent", { caller_token, intent_id: "int_1" })).resolves.toMatchObject({
      result: { ok: "cancelIntent" }
    });
    await expect(rpc(socketPath, "revokeCredential", { caller_token, credential_id: "cred_1" })).resolves.toMatchObject({
      result: { ok: "revokeCredential" }
    });
    await expect(rpc(socketPath, "ackSettlement", { caller_token, credential_id: "cred_1", event_id: "evt_1" })).resolves.toMatchObject({
      result: { ok: "ackSettlement" }
    });
    await expect(rpc(socketPath, "getPolicySnapshot", { caller_token, policy_hash: "sha256:abc" })).resolves.toMatchObject({
      result: { ok: "getPolicySnapshot" }
    });
    await expect(rpc(socketPath, "capabilities", { caller_token })).resolves.toMatchObject({
      result: { ok: "capabilities" }
    });
    await srv.stop();
  });

  it("returns JSON-RPC errors for parse, shape, method, peer, and handler failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-"));
    const socketPath = join(dir, "policy.sock");
    const srv = await new IpcServer({
      socketPath,
      tokenPath: join(dir, "caller.token"),
      handlers: {
        capabilities: async () => {
          throw new Error("boom");
        }
      }
    }).start();
    const caller_token = srv.callerToken();

    await expect(rpcRaw(socketPath, "{")).resolves.toMatchObject({ error: { code: -32700 } });
    await expect(rpcRaw(socketPath, [])).resolves.toMatchObject({ error: { code: -32600 } });
    await expect(rpcRaw(socketPath, { jsonrpc: "2.0", id: 1, params: { caller_token } })).resolves.toMatchObject({
      error: { code: -32600 }
    });
    await expect(rpcRaw(socketPath, { jsonrpc: "2.0", id: 1, method: "capabilities", params: [] })).resolves.toMatchObject({
      error: { code: -32600, message: "invalid params" }
    });
    await expect(rpc(socketPath, "unknown", { caller_token })).resolves.toMatchObject({ error: { code: -32601 } });
    await expect(rpc(socketPath, "getApprovalStatus", { caller_token })).resolves.toMatchObject({ error: { code: -32601 } });
    await expect(rpc(socketPath, "capabilities", { caller_token })).resolves.toMatchObject({ error: { code: -32000, message: "boom" } });
    await srv.stop();

    const rejectedPath = join(dir, "rejected.sock");
    const rejected = await new IpcServer({
      socketPath: rejectedPath,
      tokenPath: join(dir, "caller.token"),
      handlers: { capabilities: async () => ({ ok: true }) },
      peerCheck: () => ({ ok: false, mode: "so_peercred", reason: "wrong uid" })
    }).start();
    await expect(rpc(rejectedPath, "capabilities", { caller_token })).resolves.toMatchObject({ error: { code: -32002 } });
    await rejected.stop();
  });

  it("guards server lifecycle operations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-"));
    const srv = new IpcServer({
      socketPath: join(dir, "policy.sock"),
      tokenPath: join(dir, "caller.token"),
      handlers: { capabilities: async () => ({ ok: true }) }
    });

    await srv.stop();
    await srv.start();
    await expect(srv.start()).rejects.toThrow(/already started/);
    await srv.stop();
  });

  it("serializes bigint handler results at the IPC boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-"));
    const socketPath = join(dir, "policy.sock");
    const srv = await new IpcServer({
      socketPath,
      tokenPath: join(dir, "caller.token"),
      handlers: { capabilities: async () => ({ amount_minor: 123n }) }
    }).start();

    const response = await rpc(socketPath, "capabilities", { caller_token: srv.callerToken() });

    expect(response.result).toEqual({ amount_minor: "123" });
    await srv.stop();
  });
});
