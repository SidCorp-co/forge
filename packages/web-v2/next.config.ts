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
 * web-v2 is the canonical Forge cloud UI and serves at the host ROOT (ISS-397
 * retired v1 `packages/web` + the `/v2` prefix). Override with
 * `WEB_V2_BASE_PATH="/v2"` only to re-mount under a prefix (e.g. to run a
 * legacy build side-by-side). API/WS calls stay unprefixed (`/api`, `/ws`) so
 * the httpOnly `forge_auth` cookie + WS upgrade work.
 */
const basePath = process.env.WEB_V2_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "standalone",
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  async rewrites() {
    // `/.well-known/forge-config.json` is the canonical discovery path
    // (Matrix-style — see app/forge-config/route.ts). Next.js App Router
    // can't have a folder literally named `.well-known` (dot-prefixed
    // segments are filtered), so we rewrite to a regular route. Ported from
    // v1 with the cutover (ISS-397) so desktop discovery keeps working.
    const wellKnown = [
      {
        source: "/.well-known/forge-config.json",
        destination: "/forge-config",
      },
    ];
    if (!coreProxy) return wellKnown;
    return [
      ...wellKnown,
      { source: "/api/:path*", destination: `${coreProxy}/api/:path*` },
      { source: "/ws", destination: `${coreProxy}/ws` },
    ];
  },
};

export default nextConfig;
