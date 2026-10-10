import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { WEB_HOST_MANIFEST, readWebHostManifest } from "../contracts/src/web-host.ts";

const src = (p: string) => resolve(import.meta.dirname, p);

// The web is served by core under WEB_V2_BASE_PATH (empty: at the root); the router reads it back
// from import.meta.env.BASE_URL.
const basePath = (process.env.WEB_V2_BASE_PATH ?? "").replace(/\/+$/, "");
// `vite` (dev) proxies the API and the socket to a running core.
const core = process.env.VITE_CORE_PROXY_URL ?? "http://localhost:8080";

/** Writes web-host.json beside index.html: the routes the router declares and the help slugs, for core. */
function webHostManifest(): Plugin {
  return {
    name: "forge-web-host-manifest",
    apply: "build",
    generateBundle() {
      const tree = readFileSync(src("src/routeTree.gen.ts"), "utf8");
      const union = /\bfullPaths:((?:\s*\|\s*'[^']*')+)/.exec(tree)?.[1];
      if (!union) this.error("src/routeTree.gen.ts declares no `fullPaths` union: the router plugin's output changed shape");
      const routes = [...union.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
      const helpSlugs: unknown = JSON.parse(readFileSync(src("src/features/docs/help-slugs.generated.json"), "utf8"));
      const manifest = readWebHostManifest({ basePath, routes, helpSlugs });
      if ("refused" in manifest) this.error(`the web host manifest is refused: ${manifest.refused}`);
      this.emitFile({ type: "asset", fileName: WEB_HOST_MANIFEST, source: JSON.stringify(manifest) });
    },
  };
}

export default defineConfig({
  base: `${basePath}/`,
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      routeFileIgnorePattern: "\\.test\\.",
    }),
    tailwindcss(),
    // React Compiler through oxc (oxc-transform-react): memoises components and hooks at build time,
    // in Rust, in place of the Babel pass that took most of the build
    react({ compiler: true }),
    webHostManifest(),
  ],
  // Workspace packages resolve to their sources, as the typecheck reads them: nothing is built first.
  resolve: {
    alias: [
      { find: /^@forge\/contracts\/(.*)$/, replacement: src("../contracts/src/$1") },
      { find: "@forge/core/public", replacement: src("../core/src/public.ts") },
      { find: "@forge/core/admin-types", replacement: src("../core/src/admin/types.ts") },
      { find: "@forge/observability", replacement: src("../observability/src/index.ts") },
      { find: /^@\/(.*)$/, replacement: src("src/$1") },
    ],
  },
  server: {
    port: 3100,
    proxy: {
      "/api": { target: core, changeOrigin: true },
      "/ws": { target: core, ws: true, changeOrigin: true },
      "/forge-config": { target: core, changeOrigin: true },
      "/.well-known/forge-config.json": { target: core, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
