#!/usr/bin/env node
import { runAgent } from "./index.js";

void runAgent(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
