import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const CALLER_TOKEN_BYTES = 32;
const PRIVATE_FILE_MODE = 0o600;

export interface FileSecurityStatus {
  path: string;
  mode: number;
  uid?: number;
  expected_uid?: number;
}

export interface PeerCredentials {
  uid?: number;
  gid?: number;
  pid?: number;
}

export type PeerCredentialCheck =
  | {
      ok: true;
      mode: "so_peercred";
      credentials: PeerCredentials;
    }
  | {
      ok: true;
      mode: "filesystem_fallback";
      reason: string;
    }
  | {
      ok: false;
      mode: "so_peercred";
      reason: string;
      credentials?: PeerCredentials;
    }
  | {
      ok: false;
      mode: "filesystem_fallback";
      reason: string;
    };

interface PeerCredentialReadable {
  getPeerCredentials?: () => PeerCredentials;
}

export class CallerTokenManager {
  constructor(private readonly path: string) {}

  ensure(): string {
    ensureParentDirectory(this.path);
    if (!existsSync(this.path)) {
      const token = randomBytes(CALLER_TOKEN_BYTES).toString("hex");
      try {
        writeFileSync(this.path, `${token}\n`, { flag: "wx", mode: PRIVATE_FILE_MODE });
      } catch (error) {
        if (!isFileAlreadyExistsError(error)) throw error;
      }
    }

    enforcePrivatePath(this.path);
    const token = readFileSync(this.path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new Error(`caller token file ${this.path} does not contain a 32-byte hex token`);
    }
    return token;
  }

  verify(candidate: string): boolean {
    const truth = this.ensure();
    const candidateBuffer = Buffer.from(candidate, "utf8");
    const truthBuffer = Buffer.from(truth, "utf8");
    if (candidateBuffer.length !== truthBuffer.length) return false;
    return timingSafeEqual(candidateBuffer, truthBuffer);
  }
}

export function enforceSocketPathSecurity(socketPath: string): FileSecurityStatus {
  return enforcePrivatePath(socketPath);
}

export function checkPeerCredentials(
  socket: unknown,
  opts: { expected_uid?: number; allow_filesystem_fallback?: boolean } = {}
): PeerCredentialCheck {
  const expectedUid = opts.expected_uid ?? currentUid();
  const readable = socket as PeerCredentialReadable;
  const getPeerCredentials = typeof readable.getPeerCredentials === "function" ? readable.getPeerCredentials.bind(readable) : undefined;

  if (getPeerCredentials) {
    const credentials = getPeerCredentials();
    if (typeof expectedUid !== "number") {
      return {
        ok: false,
        mode: "so_peercred",
        reason: "cannot compare peer credentials because current uid is unavailable",
        credentials
      };
    }
    if (credentials.uid !== expectedUid) {
      return {
        ok: false,
        mode: "so_peercred",
        reason: `peer uid ${credentials.uid ?? "unknown"} did not match engine uid ${expectedUid}`,
        credentials
      };
    }
    return { ok: true, mode: "so_peercred", credentials };
  }

  if (opts.allow_filesystem_fallback === false) {
    return {
      ok: false,
      mode: "filesystem_fallback",
      reason: "SO_PEERCRED is not exposed by this Node runtime or platform"
    };
  }

  return {
    ok: true,
    mode: "filesystem_fallback",
    reason:
      "SO_PEERCRED is not exposed by this Node runtime or platform; relying on socket path mode 0600 plus caller_token"
  };
}

function enforcePrivatePath(path: string): FileSecurityStatus {
  chmodSync(path, PRIVATE_FILE_MODE);
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  const uid = currentUid();
  if (typeof uid === "number" && stat.uid !== uid) {
    throw new Error(`${path} is owned by uid ${stat.uid}, expected ${uid}`);
  }
  if (mode !== PRIVATE_FILE_MODE) {
    throw new Error(`${path} has mode ${mode.toString(8)}, expected 600`);
  }
  return { path, mode, uid: stat.uid, expected_uid: uid };
}

function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}
