import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface BoxStore {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, data: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

export function memoryBoxStore(): BoxStore {
  const boxes = new Map<string, Uint8Array>();
  return {
    async read(name) {
      const box = boxes.get(name);
      return box ? new Uint8Array(box) : null;
    },
    async write(name, data) {
      boxes.set(name, new Uint8Array(data));
    },
    async delete(name) {
      boxes.delete(name);
    }
  };
}

export function fileBoxStore(rootDir = join(homedir(), ".steelyard")): BoxStore {
  const root = resolve(rootDir);

  return {
    async read(name) {
      try {
        return new Uint8Array(await readFile(boxPath(root, name)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(name, data) {
      const path = boxPath(root, name);
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
      await writeFile(tmp, data, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
      await chmod(path, 0o600);
    },
    async delete(name) {
      await rm(boxPath(root, name), { force: true });
    }
  };
}

function boxPath(root: string, name: string): string {
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(`invalid box name: ${name}`);
  }
  return join(root, name);
}
