#!/usr/bin/env node
// The screen witness: a real web-v2 component, mounted with the app's own compiled CSS in headless
// Chrome at each window width its entry names, measured by the probes the entry declares. jsdom lays
// nothing out, so a defect that only a width shows — a check's name cut to three characters at
// 390 px (ISS-474) — is one no vitest test here can see. This is where it goes red.
//
//   pnpm --filter web-v2 witness witness/<name>.witness.tsx --out <dir> [--clip]
//
// An entry mounts its component over a stubbed core and sets `window.__witness` to
// `{ cases: [{ name, width }], ready(): boolean, probe(): string[] }`: `ready` says the component has
// drawn what the probes read, and `probe` answers one sentence per thing that is wrong. Each case is
// one fresh load at that width; its screenshot is written to `<out>/<case>.png`. An entry whose
// component has to be used, not only looked at, declares `stages: [{ name, run() }]` in place of
// `probe`: each stage acts on the same load in order, answers (or resolves to) what is wrong after it,
// and is shot to `<out>/<case>-<stage>.png`. A probe or stage that throws, or answers anything but a
// list of sentences, fails by name. The run exits 1 naming every failed probe, and 2 when it could
// not witness at all.
//
// With `--clip` each case is also recorded as `<out>/<case>.webm`: the page's frames from ready to its
// last stage (CDP screencast, each stage held long enough to read), encoded by Chrome's own
// MediaRecorder, so no encoder is installed. A judge attaches it as the verdict's evidence (REQ-40
// BC-4). It is kept within the clip ceiling a release page shows (`RELEASE_CLIP_MAX_SECONDS`,
// `RELEASE_CLIP_MAX_BYTES`): a longer recording is played faster, and one over the byte ceiling fails
// by name rather than being written.
//
// Chrome reaches no network on some boxes, so everything is a `file://` page in `<out>`; the
// browser binary is `WITNESS_CHROME`, else `google-chrome`.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node witness/run.mjs <entry.witness.tsx> --out <dir> [--clip]";

function cannot(why) {
  console.error(`witness: ${why}`);
  process.exit(2);
}

function argsOf(argv) {
  const at = argv.indexOf("--out");
  const out = at >= 0 ? argv[at + 1] : undefined;
  const clip = argv.includes("--clip");
  const unknown = argv.find((a, i) => a.startsWith("--") && a !== "--out" && a !== "--clip" && i !== at + 1);
  if (unknown) cannot(`${unknown} is not a flag the witness takes. ${USAGE}`);
  const entry = argv.filter((a, i) => a !== "--out" && a !== "--clip" && i !== at + 1)[0];
  if (!entry) cannot(`no entry named. ${USAGE}`);
  if (!out) cannot(`no --out directory named: screenshots and the page are written there, never into the tree by default. ${USAGE}`);
  const path = resolve(process.cwd(), entry);
  if (!existsSync(path)) cannot(`entry ${path} does not exist. ${USAGE}`);
  return { entry: path, out: resolve(process.cwd(), out), clip };
}


/** Vite with the app's own Tailwind and React plugins and its aliases, read from vite.config.ts. */
async function viteFor(mode) {
  const [vite, { default: tailwindcss }, { default: react }] = await Promise.all(
    ["vite", "@tailwindcss/vite", "@vitejs/plugin-react"].map((name) =>
      import(name).catch(() => cannot(`${name} does not resolve from packages/web-v2; run pnpm install at the repository root`)),
    ),
  );
  const app = await vite.loadConfigFromFile({ command: "build", mode }, resolve(WEB, "vite.config.ts"), WEB, "silent");
  if (!app) cannot("packages/web-v2/vite.config.ts did not load");
  const shared = { root: WEB, configFile: false, logLevel: "error", resolve: { alias: app.config.resolve?.alias } };
  return { vite, shared, plugins: [tailwindcss(), react()] };
}

async function buildPage(entry, out) {
  const { vite, shared, plugins } = await viteFor("production");
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
  writeFileSync(
    resolve(out, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"></head>` +
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

/** One CDP connection: `send` answers a command's result, `next` the next event of a method, `on` every one until it is let go. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`could not open ${url}`));
  });
  let id = 0;
  const calls = new Map();
  const waits = [];
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined) {
      const call = calls.get(msg.id);
      calls.delete(msg.id);
      if (msg.error) call?.fail(new Error(`${call.method}: ${msg.error.message}`));
      else call?.ok(msg.result);
      return;
    }
    for (const l of listeners) if (l.method === msg.method) l.fn(msg.params, msg.sessionId);
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
    on: (method, fn) => {
      const l = { method, fn };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    close: () => ws.close(),
  };
}

/** How long a clip holds the page at ready and after each stage, so a reader sees what it did. */
const CLIP_HOLD_MS = 1200;
const CLIP_HEIGHT = 900;

/** The clip ceiling a release page shows (`@forge/contracts/release-page`), read from where it is declared. */
async function clipCeiling() {
  const { vite, shared } = await viteFor("production");
  const { module } = await vite.runnerImport(resolve(WEB, "../contracts/src/release-page.ts"), shared);
  return { seconds: module.RELEASE_CLIP_MAX_SECONDS, bytes: module.RELEASE_CLIP_MAX_BYTES };
}

/** The page's screencast frames while a case runs, each stamped on a clock that leaves out the time spent shooting. */
function recorder(cdp, session) {
  const frames = [];
  const started = Date.now();
  let skipped = 0;
  let pausedAt = null;
  const now = () => Date.now() - started - skipped;
  const off = cdp.on("Page.screencastFrame", (p, from) => {
    if (from !== session) return;
    cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, session).catch(() => {});
    if (pausedAt === null) frames.push({ data: p.data, at: now() });
  });
  return {
    start: (width) => cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: width, maxHeight: CLIP_HEIGHT, everyNthFrame: 1 }, session),
    pause: () => {
      pausedAt = Date.now();
    },
    resume: () => {
      if (pausedAt !== null) skipped += Date.now() - pausedAt;
      pausedAt = null;
    },
    stop: async () => {
      const end = now();
      await cdp.send("Page.stopScreencast", {}, session);
      off();
      return { frames, end };
    },
  };
}

/**
 * Runs in the page: plays the frames on a canvas, each for its hold, and records the canvas with
 * Chrome's MediaRecorder. Self-contained, since it is sent as its source text.
 */
async function encodeInPage(frames, width, height) {
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return { why: "this Chrome records no WebM" };
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  document.body.appendChild(canvas);
  const g = canvas.getContext("2d");
  const images = await Promise.all(
    frames.map(async (f) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${f.data}`;
      await img.decode();
      return img;
    }),
  );
  let current = images[0];
  const draw = () => {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    g.drawImage(current, 0, 0, width, (current.naturalHeight * width) / current.naturalWidth);
  };
  draw();
  const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: mime, videoBitsPerSecond: 1_500_000 });
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise((ok) => {
    rec.onstop = ok;
  });
  rec.start();
  const tick = setInterval(draw, 66);
  for (const [i, f] of frames.entries()) {
    current = images[i];
    draw();
    await new Promise((ok) => setTimeout(ok, f.hold));
  }
  clearInterval(tick);
  rec.stop();
  await stopped;
  const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { webm: btoa(bin) };
}

/** Each frame's hold, the whole played faster where it would run past the ceiling. */
function clipTimeline(frames, end, maxMs) {
  if (frames.length === 0) return [];
  const span = Math.max(end - frames[0].at, 1);
  const scale = Math.min(1, maxMs / span);
  return frames.map((f, i) => ({ data: f.data, hold: Math.max(1, Math.round(((frames[i + 1]?.at ?? end) - f.at) * scale)) }));
}

/** Encodes one case's recording into `<out>/<name>.webm`, or says why it could not. */
async function writeClip(send, recording, width, ceiling, out, name) {
  // half a second under the ceiling, so the encoder's own start and stop cannot carry it over
  const timed = clipTimeline(recording.frames, recording.end, ceiling.seconds * 1000 - 500);
  if (timed.length === 0) return [`the clip has no frame: Chrome sent none of the page`];
  const loaded = await send("Page.navigate", { url: "about:blank" });
  if (loaded.errorText) return [`the clip could not be encoded: ${loaded.errorText}`];
  const r = await send("Runtime.evaluate", {
    expression: `(${encodeInPage.toString()})(${JSON.stringify(timed)}, ${width}, ${CLIP_HEIGHT})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) return [`the clip could not be encoded: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`];
  const made = r.result.value;
  if (!made?.webm) return [`the clip could not be encoded: ${made?.why ?? "the page answered nothing"}`];
  const bytes = Buffer.from(made.webm, "base64");
  if (bytes.length === 0) return ["the clip encoded to no bytes"];
  if (bytes.length > ceiling.bytes) {
    return [`the clip is ${bytes.length} bytes, over the ${ceiling.bytes} a release page shows: give the entry fewer stages`];
  }
  writeFileSync(resolve(out, `${name}.webm`), bytes);
  return [];
}

async function witnessCase(cdp, session, url, c, out, ceiling) {
  const send = (method, params) => cdp.send(method, params, session);
  const metrics = (height) =>
    send("Emulation.setDeviceMetricsOverride", { width: c.width, height, deviceScaleFactor: 1, mobile: c.width < 600 });
  await metrics(900);
  const loaded = cdp.next("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  const value = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  // what a probe or a stage answered: its list of what is wrong, or why it gave none — a throw or a
  // non-list is a failure named for the step, never read as a pass or as a crash of the runner
  const answer = async (expression, step) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return [`${step} threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`];
    const wrong = r.result.value;
    if (wrong === undefined || wrong === null) return [`${step} answered nothing`];
    if (!Array.isArray(wrong) || wrong.some((w) => typeof w !== "string")) return [`${step} answered ${JSON.stringify(wrong)}, not a list of sentences`];
    return wrong;
  };
  for (let i = 0; i < 100 && !(await value("Boolean(window.__witness && window.__witness.ready())")); i++) await pause(100);
  if (!(await value("Boolean(window.__witness && window.__witness.ready())"))) return [`${c.name}: the entry never said it was ready`];
  const failures = [];
  // a page laid out wider than its window and scaled down would measure nothing a phone shows
  const laidOut = await value("window.innerWidth");
  if (laidOut !== c.width) failures.push(`the page laid out at ${laidOut} px, not the case's ${c.width} px`);
  // a clip records what the window shows; the full-height screenshot between stages is left out of it
  const rec = ceiling ? recorder(cdp, session) : null;
  const hold = () => (rec ? pause(CLIP_HOLD_MS) : Promise.resolve());
  const shoot = async (name) => {
    rec?.pause();
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    await metrics(Math.ceil(cssContentSize.height));
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(shot.data, "base64"));
    await metrics(900);
    rec?.resume();
  };
  if (rec) {
    await rec.start(c.width);
    await hold();
  }
  const stages = await value("Array.isArray(window.__witness.stages) ? window.__witness.stages.map((s) => s.name) : null");
  if (!stages) {
    failures.push(...(await answer("window.__witness.probe()", "the entry's probe")));
    await shoot(c.name);
  } else {
    for (const [i, stage] of stages.entries()) {
      const wrong = await answer(`Promise.resolve(window.__witness.stages[${i}].run())`, "the stage");
      failures.push(...wrong.map((f) => `${stage}: ${f}`));
      await hold();
      await shoot(`${c.name}-${stage}`);
    }
  }
  if (rec) failures.push(...(await writeClip(send, await rec.stop(), c.width, ceiling, out, c.name)));
  return failures.map((f) => `${c.name} (${c.width} px): ${f}`);
}

async function main() {
  const { entry, out, clip } = argsOf(process.argv.slice(2));
  mkdirSync(out, { recursive: true });
  const url = await buildPage(entry, out);
  const ceiling = clip ? await clipCeiling() : null;
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
    // what an entry logs is what it measured (a page's word count), so it reaches the run's output
    cdp.on("Runtime.consoleAPICalled", (p, from) => {
      if (from === sessionId && p.type === "log") console.log(`witness: page says ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    const loaded = cdp.next("Page.loadEventFired");
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
    const cases = (await cdp.send("Runtime.evaluate", { expression: "window.__witness && window.__witness.cases", returnByValue: true }, sessionId)).result.value;
    if (!Array.isArray(cases) || cases.length === 0) cannot(`${basename(entry)} set no window.__witness.cases`);
    for (const c of cases) failures.push(...(await witnessCase(cdp, sessionId, url, c, out, ceiling)));
    console.log(`witness: ${basename(entry)}, ${cases.length} case(s), screenshots${clip ? " and clips" : ""} in ${out}`);
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
