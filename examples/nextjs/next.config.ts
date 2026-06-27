import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Silence multi-lockfile inference: pin the workspace root explicitly.
  outputFileTracingRoot: __dirname,
  // The Steelyard buyer wallet uses @napi-rs/keyring (a native Node module) for
  // local secret storage. Webpack cannot bundle a .node binary, so externalize
  // the keyring on the server. The wallet is never invoked from the route
  // handlers used by the demo (manifest serving + read surfaces only), so this
  // require is effectively dead at runtime here.
  serverExternalPackages: ["@napi-rs/keyring"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Belt-and-braces: also externalize via webpack so the transitive native
      // require from @steelyard/buyer/wallet stays a runtime `require()`.
      const existing = config.externals ?? [];
      config.externals = [
        ...(Array.isArray(existing) ? existing : [existing]),
        ({ request }: { request?: string }, callback: (err?: unknown, result?: string) => void) => {
          if (request && /^@napi-rs\/keyring(\/.*)?$/.test(request)) {
            return callback(undefined, `commonjs ${request}`);
          }
          callback();
        }
      ];
    }
    return config;
  }
};

export default nextConfig;
