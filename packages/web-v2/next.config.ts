import type { NextConfig } from "next";

const coreProxy = process.env.E2E_CORE_PROXY_URL;

const basePath = process.env.WEB_V2_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "standalone",
  // Type checking is `pnpm tc:changed` / `tsc`, not the image build. Next bundles @forge/* from
  // their package exports (dist/): Turbopack does not map a `.js` import to its `.ts` source in
  // files reached through tsconfig.json's @forge `paths`. tsconfig.next.json is tsconfig.json
  // without those, standalone because Turbopack merges an extended config's `paths`.
  typescript: { ignoreBuildErrors: true, tsconfigPath: "tsconfig.next.json" },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
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
