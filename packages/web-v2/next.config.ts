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

/**
 * web-v2 mounts under `/v2` on the same origin as the current web (v1 at `/`,
 * v2 at `/v2`) so the two run side-by-side with NO env config. Override with
 * `WEB_V2_BASE_PATH=""` only for the big-bang cutover (serve v2 at root).
 * API/WS calls stay unprefixed (`/api`, `/ws`) so the shared httpOnly cookie +
 * WS upgrade work across both.
 */
const basePath = process.env.WEB_V2_BASE_PATH ?? "/v2";

const nextConfig: NextConfig = {
  output: "standalone",
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  async rewrites() {
    if (!coreProxy) return [];
    return [
      { source: "/api/:path*", destination: `${coreProxy}/api/:path*` },
      { source: "/ws", destination: `${coreProxy}/ws` },
    ];
  },
};

export default nextConfig;
