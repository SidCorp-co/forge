import { resolve } from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const src = (p: string) => resolve(import.meta.dirname, p);

// The web is served by core under WEB_V2_BASE_PATH (empty: at the root); the router reads it back
// from import.meta.env.BASE_URL.
const basePath = (process.env.WEB_V2_BASE_PATH ?? "").replace(/\/+$/, "");
// `vite` (dev) proxies the API and the socket to a running core.
const core = process.env.VITE_CORE_PROXY_URL ?? "http://localhost:8080";

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
    react(),
    // React Compiler, through Babel (the official setup): memoises components and hooks at build time
    babel({ presets: [reactCompilerPreset()] }),
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
