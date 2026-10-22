// The witness page: an entry and the app's stylesheet bundled as one script and one stylesheet, opened
// from file:// beside an index.html, so Chrome needs no server and no network. `run.mjs` loads it;
// it is a module of its own so a test can build an entry the way a run does.

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Vite with the app's own Tailwind and React plugins and its aliases, read from vite.config.ts. */
export async function viteFor(mode) {
  const [vite, { default: tailwindcss }, { default: react }] = await Promise.all(
    ["vite", "@tailwindcss/vite", "@vitejs/plugin-react"].map((name) =>
      import(name).catch(() => {
        throw new Error(`${name} does not resolve from packages/web-v2; run pnpm install at the repository root`);
      }),
    ),
  );
  const app = await vite.loadConfigFromFile({ command: "build", mode }, resolve(WEB, "vite.config.ts"), WEB, "silent");
  if (!app) throw new Error("packages/web-v2/vite.config.ts did not load");
  const shared = { root: WEB, configFile: false, logLevel: "error", resolve: { alias: app.config.resolve?.alias } };
  return { vite, shared, plugins: [tailwindcss(), react()] };
}

/** web-v2 declares every module but its stylesheets free of side effects (`sideEffects` in its
 *  package.json), so the app's bundle keeps only the parts of the design kit a page uses. An entry is
 *  nothing but side effects: it mounts its component and sets `window.__witness`, and the page
 *  imports it bare. Under that declaration the bundler dropped the entry whole and wrote an empty
 *  app.js, for every entry, since the web left Next.js (dev.232). The entry alone is marked as
 *  having them; everything it imports is still judged by the package's own declaration. */
export function keepEntry(entry) {
  return {
    name: "witness-entry-effects",
    enforce: "post",
    transform(code, id) {
      return id === entry ? { code, map: null, moduleSideEffects: true } : null;
    },
  };
}

const PICTURES = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };

/** The app names a picture of `public/` by the path core serves it at (`src/lib/asset.ts:assetPath`),
 *  and a file:// page resolves that path against the disk's root: every mascot and mark drew broken,
 *  its alt text in its place. In the witness each picture rides in app.js as a data URI, as the fonts
 *  do; any other path (a route) is the app's own. */
export function publicPictures() {
  const asset = resolve(WEB, "src/lib/asset.ts");
  return {
    name: "witness-public-pictures",
    enforce: "pre",
    load(id) {
      if (id !== asset) return null;
      const dir = resolve(WEB, "public");
      const pictures = Object.fromEntries(
        readdirSync(dir)
          .filter((f) => PICTURES[extname(f)])
          .map((f) => [`/${f}`, `data:${PICTURES[extname(f)]};base64,${readFileSync(resolve(dir, f)).toString("base64")}`]),
      );
      return `const PICTURES = ${JSON.stringify(pictures)};\nexport function assetPath(path) {\n  return PICTURES[path] ?? path;\n}\n`;
    },
  };
}

export async function buildPage(entry, out) {
  const { vite, shared, plugins: app } = await viteFor("production");
  const plugins = [...app, keepEntry(entry), publicPictures()];
  // the entry and the app's stylesheet are bundled as one page: the stylesheets components import
  // themselves (the workflow canvas, the board) land in the same app.css, so a canvas is drawn as the
  // app draws it; nothing an earlier run left in `<out>` is read as this one's
  for (const old of ["app.js", "app.css", "components.css", "page.ts"]) rmSync(resolve(out, old), { force: true });
  const page = resolve(out, "page.ts");
  writeFileSync(page, `import ${JSON.stringify(resolve(WEB, "src/styles/globals.css"))};\nimport ${JSON.stringify(entry)};\n`);
  await vite.build({
    ...shared,
    plugins,
    mode: "production",
    define: { "process.env.NODE_ENV": '"production"' },
    build: {
      outDir: out,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      // fonts and images ride inside app.css and app.js: the page is opened from file:// with no server
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      lib: { entry: page, formats: ["iife"], name: "witness", fileName: () => "app.js", cssFileName: "app" },
    },
  });
  rmSync(page, { force: true });
  // an entry the bundler judged to have no effect is dropped whole, and the page would load, run
  // nothing and say nothing: refused here by name instead
  if (statSync(resolve(out, "app.js")).size === 0) {
    throw new Error(`${entry} bundled to an empty app.js: the bundler dropped the entry, so nothing it mounts would run`);
  }
  writeFileSync(
    resolve(out, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"></head>` +
      '<body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script src="app.js"></script></body></html>',
  );
  return pathToFileURL(resolve(out, "index.html")).href;
}
