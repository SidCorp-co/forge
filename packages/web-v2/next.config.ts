import type { NextConfig } from "next";

/**
 * web-v2 — the redesigned Forge cloud UI (parallel package, see
 * docs/proposals/web-v2-redesign.md). Shares the same `core` REST/WS
 * contract as `packages/web`.
 *
 * When `E2E_CORE_PROXY_URL` is set (dev / CI / Playwright), Next.js proxies
 * `/api/*` and `/ws` to core so browser requests stay same-origin (the
 * httpOnly `forge_auth` cookie survives, WS upgrade avoids a pre-flight).
 */
const coreProxy = process.env.E2E_CORE_PROXY_URL;

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    if (!coreProxy) return [];
    return [
      { source: "/api/:path*", destination: `${coreProxy}/api/:path*` },
      { source: "/ws", destination: `${coreProxy}/ws` },
    ];
  },
};

export default nextConfig;
