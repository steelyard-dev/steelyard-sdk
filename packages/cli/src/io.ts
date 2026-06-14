// Copyright (c) Steelyard contributors. MIT License.
import type { Readable, Writable } from "node:stream";

export interface CliIO {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface CommandResult {
  code: number;
}

export function defaultIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd()
  };
}

export function writeLine(stream: Writable, value = ""): void {
  stream.write(`${value}\n`);
}
