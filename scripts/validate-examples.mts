import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { resolve } from "node:path";
import { createCoffeeShopHandler } from "../examples/coffee-shop/src/server.js";

const COMMERCE_MANIFEST_PATH = "/.well-known/commerce.json";
const STEELYARD_BIN = resolve("packages/cli/bin/steelyard");

interface ExampleServer {
  name: string;
  handler: RequestListener;
}

const examples: ExampleServer[] = [
  {
    name: "coffee-shop",
    handler: createCoffeeShopHandler({ generatedAt: "2026-06-14T12:00:00.000Z" })
  }
];

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  for (const example of examples) {
    const server = createServer(example.handler);
    try {
      const baseUrl = await listen(server);
      const manifestUrl = `${baseUrl}${COMMERCE_MANIFEST_PATH}`;
      console.log(`validating ${example.name}: ${manifestUrl}`);
      await run("node", [
        STEELYARD_BIN,
        "validate",
        manifestUrl,
        "--allow-private-network",
        "--strict"
      ]);
    } finally {
      await closeServer(server);
    }
  }

  await run("pnpm", ["--filter", "@steelyard/example-coffee-shop", "smoke:stripe:ucp"], {
    ...process.env,
    STEELYARD_MOCK_STRIPE: "1",
    STRIPE_TEST_SECRET_KEY: "sk_test_mock"
  });
  await run("pnpm", ["--filter", "@steelyard/example-coffee-shop", "smoke:ucp:dual"], {
    ...process.env,
    STEELYARD_MOCK_STRIPE: "1",
    STEELYARD_ALLOW_REFERENCE_PSP: "1",
    STRIPE_TEST_SECRET_KEY: "sk_test_mock"
  });
  await run("pnpm", ["--filter", "@steelyard/example-coffee-shop", "smoke:stripe:acp"], {
    ...process.env,
    STEELYARD_MOCK_STRIPE: "1",
    STRIPE_TEST_SECRET_KEY: "sk_test_mock"
  });
}

async function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
