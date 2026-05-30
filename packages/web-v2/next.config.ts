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
 * Release mounts web-v2 under `/v2` on the same origin as the current web
 * (reverse-proxied). Set `WEB_V2_BASE_PATH=/v2` in the deploy env; local dev
 * leaves it empty so the app stays at `/`. API/WS calls intentionally stay
 * unprefixed (`/api`, `/ws`) so the shared httpOnly cookie + WS upgrade work.
 */
const basePath = process.env.WEB_V2_BASE_PATH || "";

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
