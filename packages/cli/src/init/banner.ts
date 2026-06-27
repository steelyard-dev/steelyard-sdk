// Copyright (c) Steelyard contributors. MIT License.
//
// ASCII banner for `steelyard init`. Treated as a first-class part of the
// product surface — must look good at 80 columns, suppress in CI / piped
// output, and respect NO_COLOR.

import pc from "picocolors";

const LINES = [
  " ░██████  ░██████████ ░██████████ ░██████████ ░██     ░██░██    ░██   ░███    ░█████████  ░██████████",
  "░██   ░██     ░██     ░██         ░██         ░██     ░██░██    ░██   ░██░██   ░██     ░██ ░██     ░██",
  "░██           ░██     ░██         ░██         ░██     ░██░██    ░██  ░██  ░██  ░██     ░██ ░██     ░██",
  " ░████████    ░██     ░█████████  ░█████████  ░██     ░██░██    ░██ ░█████████ ░█████████  ░██     ░██",
  "       ░██    ░██     ░██         ░██         ░██     ░██░██    ░██ ░██    ░██ ░██   ░██   ░██     ░██",
  " ░██   ░██    ░██     ░██         ░██         ░██     ░██ ░██  ░██  ░██     ░██░██    ░██  ░██     ░██",
  "  ░██████     ░██     ░██████████ ░██████████  ░██████    ░██████   ░██     ░██░██     ░██ ░██████████"
];

const LABEL = "STEELYARD";
const TAGLINE = "Define commerce once · serve it everywhere · let agents buy";

export interface RenderBannerOptions {
  tty: boolean;
  noColor: boolean;
}

export function renderBanner(opts: RenderBannerOptions): string {
  if (!opts.tty) return "";
  const colored = opts.noColor ? (s: string) => s : (s: string) => pc.cyan(s);
  const dim = opts.noColor ? (s: string) => s : (s: string) => pc.dim(s);
  return `\n${LINES.map(colored).join("\n")}\n\n  ${colored(LABEL)}  ${dim(TAGLINE)}\n`;
}

export function shouldShowBanner(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean | undefined): boolean {
  if (env.STEELYARD_NO_BANNER === "1") return false;
  if (env.CI) return false;
  return Boolean(stdoutIsTTY);
}
