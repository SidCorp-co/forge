#!/usr/bin/env node
// The screen witness: a real web-v2 component, mounted with the app's own compiled CSS in headless
// Chrome at each window width its entry names, measured by the probes the entry declares. jsdom lays
// nothing out, so a defect that only a width shows — a check's name cut to three characters at
// 390 px (ISS-474) — is one no vitest test here can see. This is where it goes red.
//
//   pnpm --filter web-v2 witness witness/<name>.witness.tsx --out <dir>
//
// An entry mounts its component over a stubbed core and sets `window.__witness` to
// `{ cases: [{ name, width }], ready(): boolean, probe(): string[] }`: `ready` says the component has
// drawn what the probes read, and `probe` answers one sentence per thing that is wrong. Each case is
// one fresh load at that width; its screenshot is written to `<out>/<case>.png`. The run exits 1
// naming every failed probe, and 2 when it could not witness at all.
//
// Chrome reaches no network on some boxes, so everything is a `file://` page in `<out>`; the
// browser binary is `WITNESS_CHROME`, else `google-chrome`.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node witness/run.mjs <entry.witness.tsx> --out <dir>";

function cannot(why) {
  console.error(`witness: ${why}`);
  process.exit(2);
}

function argsOf(argv) {
  const at = argv.indexOf("--out");
  const out = at >= 0 ? argv[at + 1] : undefined;
  const entry = argv.filter((a, i) => a !== "--out" && i !== at + 1)[0];
  if (!entry) cannot(`no entry named. ${USAGE}`);
  if (!out) cannot(`no --out directory named: screenshots and the page are written there, never into the tree by default. ${USAGE}`);
  const path = resolve(process.cwd(), entry);
  if (!existsSync(path)) cannot(`entry ${path} does not exist. ${USAGE}`);
  return { entry: path, out: resolve(process.cwd(), out) };
}

const need = createRequire(resolve(WEB, "package.json"));
function load(name) {
  try {
    return need(name);
  } catch {
    cannot(`${name} does not resolve from packages/web-v2; run pnpm install at the repository root`);
  }
}

async function buildPage(entry, out) {
  const esbuild = load("esbuild");
  await esbuild.build({
    entryPoints: [entry],
    outfile: resolve(out, "app.js"),
    bundle: true,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    tsconfig: resolve(WEB, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });
  const postcss = load("postcss");
  const tailwind = load("@tailwindcss/postcss");
  const from = resolve(WEB, "src/app/globals.css");
  const css = await postcss([tailwind({ base: WEB })]).process(readFileSync(from, "utf8"), { from });
  writeFileSync(resolve(out, "app.css"), css.css);
  writeFileSync(
    resolve(out, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"></head>' +
      '<body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script src="app.js"></script></body></html>',
  );
  return pathToFileURL(resolve(out, "index.html")).href;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtoolsOf(profile, chrome) {
  const file = resolve(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (chrome.exitCode !== null) cannot(`${chrome.spawnfile} exited ${chrome.exitCode} before it listened`);
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, "utf8").trim().split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await pause(100);
  }
  cannot(`${chrome.spawnfile} wrote no DevToolsActivePort in 10s`);
}

/** One CDP connection: `send` answers a command's result, `next` the next event of a method. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`could not open ${url}`));
  });
  let id = 0;
  const calls = new Map();
  const waits = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined) {
      const call = calls.get(msg.id);
      calls.delete(msg.id);
      if (msg.error) call?.fail(new Error(`${call.method}: ${msg.error.message}`));
      else call?.ok(msg.result);
      return;
    }
    const at = waits.findIndex((w) => w.method === msg.method);
    if (at >= 0) waits.splice(at, 1)[0].ok(msg.params);
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((ok, fail) => {
        id += 1;
        calls.set(id, { ok, fail, method });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    next: (method) => new Promise((ok) => waits.push({ method, ok })),
    close: () => ws.close(),
  };
}

async function witnessCase(cdp, session, url, c, out) {
  const send = (method, params) => cdp.send(method, params, session);
  const metrics = (height) =>
    send("Emulation.setDeviceMetricsOverride", { width: c.width, height, deviceScaleFactor: 1, mobile: c.width < 600 });
  await metrics(900);
  const loaded = cdp.next("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  const value = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  for (let i = 0; i < 100 && !(await value("Boolean(window.__witness && window.__witness.ready())")); i++) await pause(100);
  if (!(await value("Boolean(window.__witness && window.__witness.ready())"))) return [`${c.name}: the entry never said it was ready`];
  const failures = (await value("window.__witness.probe()")) ?? ["the entry's probe answered nothing"];
  // a page laid out wider than its window and scaled down would measure nothing a phone shows
  const laidOut = await value("window.innerWidth");
  if (laidOut !== c.width) failures.push(`the page laid out at ${laidOut} px, not the case's ${c.width} px`);
  const { cssContentSize } = await send("Page.getLayoutMetrics");
  await metrics(Math.ceil(cssContentSize.height));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(out, `${c.name}.png`), Buffer.from(shot.data, "base64"));
  return failures.map((f) => `${c.name} (${c.width} px): ${f}`);
}

async function main() {
  const { entry, out } = argsOf(process.argv.slice(2));
  mkdirSync(out, { recursive: true });
  const url = await buildPage(entry, out);
  const profile = resolve(out, ".chrome-profile");
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(
    process.env.WITNESS_CHROME || "google-chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );
  chrome.on("error", (e) => cannot(`could not start ${chrome.spawnfile}: ${e.message}; set WITNESS_CHROME to a Chrome binary`));
  let cdp;
  const failures = [];
  try {
    cdp = await connect(await devtoolsOf(profile, chrome));
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    const loaded = cdp.next("Page.loadEventFired");
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
    const cases = (await cdp.send("Runtime.evaluate", { expression: "window.__witness && window.__witness.cases", returnByValue: true }, sessionId)).result.value;
    if (!Array.isArray(cases) || cases.length === 0) cannot(`${basename(entry)} set no window.__witness.cases`);
    for (const c of cases) failures.push(...(await witnessCase(cdp, sessionId, url, c, out)));
    console.log(`witness: ${basename(entry)}, ${cases.length} case(s), screenshots in ${out}`);
  } finally {
    cdp?.close();
    chrome.kill("SIGKILL");
    await pause(200);
    rmSync(profile, { recursive: true, force: true });
  }
  for (const f of failures) console.error(`witness: FAIL ${f}`);
  if (failures.length) process.exit(1);
  console.log("witness: every probe held");
}

main().catch((e) => cannot(e instanceof Error ? e.message : String(e)));
