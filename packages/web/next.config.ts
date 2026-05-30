import type { NextConfig } from "next";

/**
 * Phase 2.6-F4: when `E2E_CORE_PROXY_URL` is set (CI/Playwright), Next.js
 * proxies `/api/*` and `/ws/*` to core. This keeps browser requests
 * same-origin so the httpOnly `forge_auth` cookie survives with
 * SameSite=Lax and WS upgrades avoid a cross-origin pre-flight.
 */
const coreProxy = process.env.E2E_CORE_PROXY_URL;

// web-v2 (the redesigned UI) runs as a sibling container at basePath `/v2`.
// We proxy `/v2/*` to it from v1 here — keeping the `/v2` prefix intact — so it
// works regardless of the reverse proxy (Coolify path-domains strip the prefix,
// which breaks Next basePath). web-v2 therefore needs NO public domain of its
// own; it stays internal and v1 owns the host. Override the upstream with
// `WEB_V2_UPSTREAM` (default = the compose service name on the shared network).
const webV2Upstream = process.env.WEB_V2_UPSTREAM || "http://web-v2:3000";

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
    const v2 = [
      { source: "/v2", destination: `${webV2Upstream}/v2` },
      { source: "/v2/:path*", destination: `${webV2Upstream}/v2/:path*` },
    ];
    if (coreProxy) {
      return [
        ...wellKnown,
        ...v2,
        { source: "/api/:path*", destination: `${coreProxy}/api/:path*` },
        { source: "/ws", destination: `${coreProxy}/ws` },
      ];
    }
    return [...wellKnown, ...v2];
  },
};

export default nextConfig;
