import type { NextConfig } from "next";

/**
 * Phase 2.6-F4: when `E2E_CORE_PROXY_URL` is set (CI/Playwright), Next.js
 * proxies `/api/*` and `/ws/*` to core. This keeps browser requests
 * same-origin so the httpOnly `forge_auth` cookie survives with
 * SameSite=Lax and WS upgrades avoid a cross-origin pre-flight.
 */
const coreProxy = process.env.E2E_CORE_PROXY_URL;

const nextConfig: NextConfig = coreProxy
  ? {
      async rewrites() {
        return [
          { source: "/api/:path*", destination: `${coreProxy}/api/:path*` },
          { source: "/ws", destination: `${coreProxy}/ws` },
        ];
      },
    }
  : {};

export default nextConfig;
