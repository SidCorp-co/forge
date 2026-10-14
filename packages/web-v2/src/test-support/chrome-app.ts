// Runs the app's own components, bundled, in the Chrome `warmChrome` left running: jsdom has no
// layout, so where a scroll comes to rest once rows are measured is only readable in a browser. A
// scenario is a page that renders a component, drives it and reports what it measured.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { appStylesheet, runningChrome } from "./chrome-layout";

const WEB_V2 = resolve(__dirname, "../..");

const bundles = new Map<string, Promise<string>>();

function bundled(entry: string): Promise<string> {
  let made = bundles.get(entry);
  if (!made) {
    made = build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      alias: { "@": resolve(WEB_V2, "src") },
      define: { "process.env.NODE_ENV": '"production"' },
      absWorkingDir: WEB_V2,
      logLevel: "silent",
    }).then((result) => (result.outputFiles[0] as { text: string }).text);
    bundles.set(entry, made);
    made.catch(() => bundles.delete(entry));
  }
  return made;
}

/**
 * Opens `entry` in a frame `viewport` px wide, so the responsive utilities answer for that screen
 * (Chrome will not make a window narrower than 500px, and a frame is its own viewport). The page reads
 * `location.hash` as the scenario to run and reports by `parent.postMessage(btoa(json))`.
 */
export async function runInApp<T>(entry: string, scenario: string, viewport: number, waitMs = 20_000): Promise<T> {
  const chrome = await runningChrome();
  const [js, css] = await Promise.all([bundled(entry), appStylesheet()]);
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body style="margin:0"><div id="root"></div><script src="app.js"></script></body></html>`;
  const outer = `<!doctype html><html><body style="margin:0"><iframe src="inner.html#${encodeURIComponent(scenario)}" style="width:${viewport}px;height:900px;border:0"></iframe><pre id="reach"></pre><script>addEventListener("message", (e) => { document.getElementById("reach").textContent = e.data; });</script></body></html>`;
  const dir = mkdtempSync(join(tmpdir(), "forge-chrome-app-"));
  try {
    writeFileSync(join(dir, "app.js"), js);
    writeFileSync(join(dir, "inner.html"), inner);
    writeFileSync(join(dir, "outer.html"), outer);
    const body = await chrome.evaluateWhenReady(`file://${join(dir, "outer.html")}`, 'document.getElementById("reach")?.textContent ?? ""', waitMs);
    if (!body) throw new Error(`Chrome loaded ${entry} for the scenario "${scenario}" at ${viewport}px and no report came back within ${waitMs}ms: the page threw before it reported, or the scenario never finished.`);
    return JSON.parse(Buffer.from(body, "base64").toString("utf8")) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
