import type { NextConfig } from "next";

const coreProxy = process.env.E2E_CORE_PROXY_URL;

const basePath = process.env.WEB_V2_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "standalone",
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
