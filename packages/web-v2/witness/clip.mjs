#!/usr/bin/env node
// The judge's screen clip (REQ-40 BC-4): one short recording of the running build doing what a
// criterion says, kept as that verdict's evidence so a release page can show it (BC-3). Where the
// screen witness (`run.mjs --clip`) records a component over a stubbed core, this records the real
// product at a URL, signed in as a person.
//
//   pnpm --filter web-v2 clip <url> --out <dir> [--name <name>] [--width 390] [--height <px>]
//                             [--theme light|dark] [--steps <module.mjs>] [--login]
//
// Playwright's own recorder writes the WebM (`recordVideo`), through the encoder Playwright installs
// beside its browsers, so nothing else is installed. Chrome is `WITNESS_CHROME`, else
// `google-chrome`. `--login` signs in at `<origin>/login` first, outside the recording, with
// `FORGE_CLIP_EMAIL` and `FORGE_CLIP_PASSWORD` from the environment, never from arguments. `--steps`
// names a module whose default export `async (page, { hold })` acts on the page after it loads;
// without one the page is held long enough to read. Beside `<name>.webm` the last frame is written
// as `<name>.png`, the still a release page opens the clip on.
//
// A clip is kept within the ceiling a release page shows (`RELEASE_CLIP_MAX_SECONDS`,
// `RELEASE_CLIP_MAX_BYTES`): one over either fails by name and nothing is written. Exit 0 prints the
// two files and how to attach and cite them; 1 is a clip refused; 2 is a run that could not record.

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { viteFor } from "./build-page.mjs";

const USAGE =
  "usage: node witness/clip.mjs <url> --out <dir> [--name <name>] [--width 390] [--height <px>] [--theme light|dark] [--steps <module.mjs>] [--login]";
const VALUED = new Set(["--out", "--name", "--width", "--height", "--theme", "--steps"]);
const FLAGS = new Set(["--login"]);
const HOLD_MS = 1200;

function cannot(why) {
  console.error(`clip: ${why}`);
  process.exit(2);
}

function refused(why) {
  console.error(`clip: refused: ${why}`);
  process.exit(1);
}

/** The run's arguments, each refused by name where it is not one this recorder takes. */
export function argsOf(argv) {
  const named = {};
  const loose = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) cannot(`${a} takes a value. ${USAGE}`);
      named[a.slice(2)] = v;
      i++;
    } else if (FLAGS.has(a)) named[a.slice(2)] = true;
    else if (a.startsWith("--")) cannot(`${a} is not a flag the recorder takes. ${USAGE}`);
    else loose.push(a);
  }
  const [url, ...extra] = loose;
  if (!url) cannot(`no URL named. ${USAGE}`);
  if (extra.length > 0) cannot(`one URL per clip; also named ${extra.join(", ")}. ${USAGE}`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    cannot(`${url} is not a URL. ${USAGE}`);
  }
  if (!named.out) cannot(`no --out directory named: the clip is written there, never into the tree. ${USAGE}`);
  const width = Number(named.width ?? 1440);
  const height = Number(named.height ?? (width < 600 ? 844 : 900));
  if (!Number.isInteger(width) || width < 320 || width > 2560) cannot(`--width ${named.width} is not a window width from 320 to 2560`);
  if (!Number.isInteger(height) || height < 480 || height > 1600) cannot(`--height ${named.height} is not a window height from 480 to 1600`);
  const theme = named.theme ?? "light";
  if (theme !== "light" && theme !== "dark") cannot(`--theme ${theme} is light or dark`);
  const name = named.name ?? `clip-${width}-${theme}`;
  if (!/^[\w.-]{1,120}$/u.test(name)) cannot(`--name ${name} is letters, digits, ".", "-" and "_", at most 120: it is the attachment's name`);
  return {
    url: parsed,
    out: resolve(process.cwd(), named.out),
    name,
    width,
    height,
    theme,
    steps: named.steps ? resolve(process.cwd(), named.steps) : null,
    login: named.login === true,
  };
}

/** The clip ceiling a release page shows (`@forge/contracts/release-page`), read from where it is declared. */
async function clipCeiling() {
  const { vite, shared } = await viteFor("production");
  const { module } = await vite.runnerImport(resolve(import.meta.dirname, "../../contracts/src/release-page.ts"), shared);
  return { seconds: module.RELEASE_CLIP_MAX_SECONDS, bytes: module.RELEASE_CLIP_MAX_BYTES };
}

async function chromium() {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    cannot("playwright-core does not resolve from packages/web-v2; run pnpm install at the repository root");
  }
}

/** Signs in outside the recording and hands back the session it opened, or refuses by name. */
async function signIn(browser, origin) {
  const email = process.env.FORGE_CLIP_EMAIL;
  const password = process.env.FORGE_CLIP_PASSWORD;
  if (!email || !password) cannot("--login reads FORGE_CLIP_EMAIL and FORGE_CLIP_PASSWORD from the environment; one is not set");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL("/login", origin).href, { waitUntil: "networkidle" });
  await page.fill("input[type=email], input[name=email]", email);
  await page.fill("input[type=password], input[name=password]", password);
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 }).catch(() => cannot(`signing in at ${origin}/login did not leave the login page in 20 s`));
  const state = await context.storageState();
  await context.close();
  return state;
}

async function stepsOf(path) {
  if (!path) return null;
  if (!existsSync(path)) cannot(`--steps ${path} does not exist`);
  const mod = await import(pathToFileURL(path).href);
  if (typeof mod.default !== "function") cannot(`--steps ${path} has no default export async (page, { hold }) => {}`);
  return mod.default;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const ceiling = await clipCeiling();
  const steps = await stepsOf(args.steps);
  mkdirSync(args.out, { recursive: true });
  const browser = await (await chromium()).launch({ executablePath: process.env.WITNESS_CHROME || "google-chrome", headless: true });
  try {
    const storageState = args.login ? await signIn(browser, args.url.origin) : undefined;
    const size = { width: args.width, height: args.height };
    const started = Date.now();
    const context = await browser.newContext({ viewport: size, colorScheme: args.theme, storageState, recordVideo: { dir: args.out, size } });
    const page = await context.newPage();
    const hold = (ms = HOLD_MS) => page.waitForTimeout(ms);
    const answer = await page.goto(args.url.href, { waitUntil: "networkidle" });
    if (!answer || answer.status() >= 400) refused(`${args.url.href} answered ${answer?.status() ?? "nothing"}`);
    await hold();
    if (steps) await steps(page, { hold });
    else await hold(2 * HOLD_MS);
    const still = resolve(args.out, `${args.name}.png`);
    await page.screenshot({ path: still });
    const video = page.video();
    await context.close();
    const seconds = (Date.now() - started) / 1000;
    const recorded = await video.path();
    const clip = resolve(args.out, `${args.name}.webm`);
    const bytes = statSync(recorded).size;
    const over =
      seconds > ceiling.seconds
        ? `the clip ran ${seconds.toFixed(1)} s, over the ${ceiling.seconds} s a release page shows; shorten its steps and record it again`
        : bytes > ceiling.bytes
          ? `the clip is ${bytes} bytes, over the ${ceiling.bytes} a release page shows; record it smaller`
          : null;
    if (over) {
      rmSync(recorded, { force: true });
      rmSync(still, { force: true });
      refused(over);
    }
    renameSync(recorded, clip);
    console.log(`clip: ${clip} (${seconds.toFixed(1)} s, ${bytes} bytes)`);
    console.log(`clip: ${still} (its opening still)`);
    console.log(`clip: attach both (forge-runner api issues/<id>/attachments -F file=@${clip}, then the .png) and cite ${args.name}.webm and ${args.name}.png in the verdict's evidence`);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => cannot(err instanceof Error ? err.message : String(err)));
}
