// Copyright (c) Steelyard contributors. MIT License.
import type { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { EcbFxQuoteService, Engine } from "@steelyard/policy";
import type { CliIO, CommandResult } from "../../io.js";
import { writeLine } from "../../io.js";

export interface PolicyRunOptions {
  policy?: string;
  dataDir?: string;
  signalSource?: Pick<EventEmitter, "on" | "off" | "once">;
  waitForShutdown?: () => Promise<void>;
}

export async function policyRunCommand(opts: PolicyRunOptions, io: CliIO): Promise<CommandResult> {
  const policyPath = resolvePath(io, opts.policy ?? io.env.STEELYARD_POLICY_PATH ?? "~/.steelyard/policy.yaml");
  const dataDir = resolvePath(io, opts.dataDir ?? io.env.STEELYARD_DATA_DIR ?? "~/.steelyard");
  const socketPath = resolvePath(io, `${dataDir}/policy.sock`);
  const clock = { now: () => new Date() };
  const engine = new Engine({
    dataDir,
    clock,
    fx: new EcbFxQuoteService({ now: clock.now }),
    rails: [],
    policyPath,
    socketPath
  });
  const signals = opts.signalSource ?? process;
  const inFlightReloads = new Set<Promise<void>>();

  const reload = (): void => {
    const task = engine
      .reloadPolicy()
      .then((snapshot) => writeLine(io.stdout, `policy reloaded; policy_hash=${snapshot.policy_hash}`))
      .catch((error: unknown) => writeLine(io.stderr, `policy reload failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => inFlightReloads.delete(task));
    inFlightReloads.add(task);
  };

  try {
    await engine.start();
    writeLine(io.stdout, `engine started; data dir=${dataDir}`);
    writeLine(io.stdout, `socket=${socketPath}`);
    writeLine(io.stdout, `caller_token=${engine.callerToken()}`);

    signals.on("SIGHUP", reload);
    await (opts.waitForShutdown ? opts.waitForShutdown() : waitForProcessShutdown(signals));
    await Promise.all([...inFlightReloads]);
    writeLine(io.stdout, "shutting down");
    return { code: 0 };
  } catch (error) {
    writeLine(io.stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  } finally {
    signals.off("SIGHUP", reload);
    await engine.stop();
  }
}

function waitForProcessShutdown(signals: Pick<EventEmitter, "once" | "off">): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
      resolve();
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
  });
}

function resolvePath(io: CliIO, value: string): string {
  const expanded = value === "~" || value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value;
  return resolve(io.cwd, expanded);
}
