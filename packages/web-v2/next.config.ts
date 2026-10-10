import type { NextConfig } from "next";

const coreProxy = process.env.E2E_CORE_PROXY_URL;

const basePath = process.env.WEB_V2_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "standalone",
  // React Compiler memoises components and hooks at build time (react.dev/learn/react-compiler);
  // hand-written useMemo/useCallback kept only for an identity an outside system needs.
  reactCompiler: true,
  // The build only builds: types are `pnpm typecheck` (tsgo), lint is `pnpm lint`. Next bundles
  // @forge/* from their package exports (dist/): Turbopack does not map a `.js` import to its `.ts`
  // source in files reached through tsconfig.json's @forge `paths`. tsconfig.next.json is
  // tsconfig.json without those, standalone because Turbopack merges an extended config's `paths`.
  typescript: { ignoreBuildErrors: true, tsconfigPath: "tsconfig.next.json" },
  experimental: {
    // No source maps: nothing reads them (sentry-release.yml uploads none), and they were 130 MB.
    turbopackSourceMaps: false,
    // Page-data workers default to one per core: 55 here, ~12 s and ~5 GB for 29 pages.
    cpus: 4,
  },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // a share page carries its token in its path: never cached, indexed or sent on as a Referer
  async headers() {
    return [
      {
        source: "/s/:token*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  async rewrites() {
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
