import type { NextConfig } from "next";

/**
 * Phase 2.6-F4: when `E2E_CORE_PROXY_URL` is set (CI/Playwright), Next.js
 * proxies `/api/*` and `/ws/*` to core. This keeps browser requests
 * same-origin so the httpOnly `forge_auth` cookie survives with
 * SameSite=Lax and WS upgrades avoid a cross-origin pre-flight.
 */
const coreProxy = process.env.E2E_CORE_PROXY_URL;

const nextConfig: NextConfig = {
  // Required for Docker production image (server.js + .next/standalone).
  output: "standalone",
  async rewrites() {
    // `/.well-known/forge-config.json` is the canonical discovery path
    // (Matrix-style — see app/forge-config/route.ts). Next.js App Router
    // can't have a folder literally named `.well-known` (dot-prefixed
    // segments are filtered), so we rewrite to a regular route.
    const wellKnown = [
      {
        source: "/.well-known/forge-config.json",
        destination: "/forge-config",
      },
    ];
    if (coreProxy) {
      return [
        ...wellKnown,
        { source: "/api/:path*", destination: `${coreProxy}/api/:path*` },
        { source: "/ws", destination: `${coreProxy}/ws` },
      ];
    }
    return wellKnown;
  },
};

export default nextConfig;
