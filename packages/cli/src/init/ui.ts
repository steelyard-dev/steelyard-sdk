// Copyright (c) Steelyard contributors. MIT License.
//
// CLI UI primitives — spinner, prompt, status lines. Thin wrappers around
// ora / prompts / picocolors that consume our CliIO so the init command is
// testable end-to-end.

import ora, { type Ora } from "ora";
import prompts, { type PromptObject, type Answers } from "prompts";
import pc from "picocolors";
import type { CliIO } from "../io.js";

export interface Ui {
  line(text: string): void;
  success(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  dim(text: string): string;
  spinner(text: string): UiSpinner;
  prompt<T extends string = string>(question: PromptObject<T>): Promise<Answers<T>>;
}

export interface UiSpinner {
  succeed(text?: string): void;
  fail(text?: string): void;
  update(text: string): void;
  stop(): void;
}

interface ColorFns {
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
}

function colorFns(noColor: boolean): ColorFns {
  if (noColor) {
    const id = (s: string) => s;
    return { green: id, yellow: id, red: id, dim: id, cyan: id };
  }
  return { green: pc.green, yellow: pc.yellow, red: pc.red, dim: pc.dim, cyan: pc.cyan };
}

export function createUi(io: CliIO): Ui {
  const isTty = Boolean((io.stdout as NodeJS.WriteStream).isTTY);
  const noColor = io.env.NO_COLOR === "1" || !isTty;
  const c = colorFns(noColor);
  const write = (s: string) => io.stdout.write(`${s}\n`);

  return {
    line: (text) => write(text),
    success: (text) => write(`${c.green("✔")} ${text}`),
    warn: (text) => write(`${c.yellow("⚠")} ${text}`),
    error: (text) => write(`${c.red("✗")} ${text}`),
    dim: (text) => c.dim(text),
    spinner: (text) => {
      if (!isTty) {
        write(`  ${c.dim("…")} ${text}`);
        return {
          succeed: (t) => write(`  ${c.green("✔")} ${t ?? text}`),
          fail: (t) => write(`  ${c.red("✗")} ${t ?? text}`),
          update: () => {},
          stop: () => {}
        };
      }
      const spin: Ora = ora({ text, color: "cyan", stream: io.stdout as NodeJS.WriteStream }).start();
      return {
        succeed: (t) => {
          spin.succeed(t ?? text);
        },
        fail: (t) => {
          spin.fail(t ?? text);
        },
        update: (t) => {
          spin.text = t;
        },
        stop: () => spin.stop()
      };
    },
    prompt: (question) =>
      prompts(question, {
        onCancel: () => {
          throw new Error("init cancelled");
        }
      })
  };
}
