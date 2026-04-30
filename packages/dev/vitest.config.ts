import { defineConfig } from "vitest/config";
import path from "path";
import fs from "fs";

// Resolve react / react-dom to a single physical copy each so renderHook()
// doesn't trip the "Invalid hook call" guard. Background:
//   * pnpm node-linker=hoisted puts react@18.3.1 (from packages/app's RN pin)
//     at the workspace-root node_modules/react.
//   * packages/dev pins react@19, so packages/dev/node_modules/react is 19.2.3.
//   * @testing-library/react ships its own nested react@19.2.3.
//   * react-dom@19.2.3 lives only at the workspace root.
// Without an alias, source hooks import the dev-local 19 while
// testing-library's CJS require("react") resolves through Node to its nested
// copy — same version, different physical file, different module instance,
// broken. Pin both to the dev-local react and the workspace-root react-dom
// (both 19.2.3) and inline @testing-library/react so its require() goes
// through vite's transform pipeline and our alias.
function findFirstExisting(...candidates: string[]): string {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("none of the candidates exist: " + candidates.join(", "));
}

const REACT_PATH = findFirstExisting(
  path.resolve(__dirname, "node_modules/react"),
  path.resolve(__dirname, "../../node_modules/react"),
);
const REACT_DOM_PATH = findFirstExisting(
  path.resolve(__dirname, "node_modules/react-dom"),
  path.resolve(__dirname, "../../node_modules/react-dom"),
);

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      { find: /^react$/, replacement: REACT_PATH },
      { find: /^react\/(.*)$/, replacement: REACT_PATH + "/$1" },
      { find: /^react-dom$/, replacement: REACT_DOM_PATH },
      { find: /^react-dom\/(.*)$/, replacement: REACT_DOM_PATH + "/$1" },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    server: {
      deps: {
        // Force these through vite so their internal require("react") /
        // require("react-dom") hits our alias (otherwise vite-node leaves
        // them external and Node's CJS resolver picks each lib's nested
        // copy).
        inline: [/@testing-library\/react/, /react-dom/],
      },
    },
    include: ["../tests/dev/**/*.test.{ts,tsx}"],
    // Remaining excluded files have domain-specific issues unrelated to the
    // React-instance problem above: use-agent-stream / use-web-socket lean
    // on long-lived event-listener maps that leak across tests; skill-sync
    // trips an isolation drift under the default vitest pool. Re-enable
    // file-by-file as those are sorted.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "../tests/dev/hooks/use-agent-stream.test.ts",
      "../tests/dev/hooks/use-web-socket.test.ts",
      "../tests/dev/lib/skill-sync.test.ts",
    ],
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
  },
});
