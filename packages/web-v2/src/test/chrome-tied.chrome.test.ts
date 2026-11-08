// @vitest-environment node
// A test's Chrome does not outlive the test process, even one killed with SIGKILL, which runs no
// `exit` hook (ISS-1059). A Node process starts Chrome with `spawnTied`, as the witness and the
// mockup test do, says Chrome's pid, and is killed; within 60 s nothing of Chrome's group is left,
// and nor is the watchdog that ended it. With the watchdog planted out, Chrome is still running
// 60 s later and this goes red. Chrome is `WITNESS_CHROME`, else `google-chrome`; a box without it
// fails here by name rather than skipping. Chrome is a program the whole-tree guard cannot read
// inside, so it counts it as listing the root; it reads only its own fresh profile.
// @gate-input whole-tree
// @direct-test-of packages/web-v2/witness/chrome-tied.mjs

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TIED = resolve(import.meta.dirname, "../../witness/chrome-tied.mjs");
const bin = process.env.WITNESS_CHROME ?? "google-chrome";

/** The process that starts Chrome: says Chrome's pid once Chrome listens, then idles until killed. */
const STARTER = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnTied } from ${JSON.stringify(TIED)};
const [bin, profile] = process.argv.slice(1);
const chrome = spawnTied(bin, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
chrome.on("error", (e) => { console.error(bin + " could not start (" + e.message + "): this test needs Chrome; set WITNESS_CHROME to its binary"); process.exit(2); });
const wait = setInterval(() => {
  if (!existsSync(join(profile, "DevToolsActivePort"))) return;
  clearInterval(wait);
  console.log("chrome " + chrome.pid);
  setInterval(() => undefined, 1000);
}, 100);
`;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const groupAlive = (group: number) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};
/** Every process whose command line is the watchdog's for `group`. */
const watchdogsOf = (group: number) =>
  readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        const args = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean);
        return args.at(-1) === String(group) && args.some((a) => a.includes("process.kill(-group"));
      } catch {
        return false;
      }
    });

let group: number | undefined;
let profile: string | undefined;

afterEach(() => {
  // what this test started and the code under test did not end, ended here by its own group
  if (group !== undefined && groupAlive(group)) process.kill(-group, "SIGKILL");
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  group = undefined;
  profile = undefined;
});

/** Starts the starter and answers it with the Chrome group it reported. */
async function started(): Promise<{ starter: ChildProcess; chrome: number }> {
  profile = mkdtempSync(join(tmpdir(), "chrome-tied-"));
  const starter = spawn(process.execPath, ["--input-type=module", "-e", STARTER, bin, profile], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  starter.stdout?.on("data", (d) => (said += String(d)));
  starter.stderr?.on("data", (d) => (said += String(d)));
  for (let i = 0; i < 300; i++) {
    const at = /chrome (\d+)/.exec(said);
    if (at) {
      group = Number(at[1]);
      return { starter, chrome: group };
    }
    if (starter.exitCode !== null) break;
    await pause(100);
  }
  starter.kill("SIGKILL");
  throw new Error(`the starter never said Chrome was listening in 30s (exit ${starter.exitCode}): ${said.trim() || "it said nothing"}`);
}

describe("a Chrome started with spawnTied", () => {
  it("is gone within 60 s of its starter being killed with SIGKILL, and so is its watchdog", async () => {
    const { starter, chrome } = await started();
    expect(groupAlive(chrome), "Chrome's group was not running once it listened").toBe(true);
    process.kill(starter.pid as number, "SIGKILL");
    const until = Date.now() + 60_000;
    while ((groupAlive(chrome) || watchdogsOf(chrome).length > 0) && Date.now() < until) await pause(250);
    expect(groupAlive(chrome), `Chrome's group ${chrome} outlived its SIGKILLed starter by 60 s`).toBe(false);
    expect(watchdogsOf(chrome), `the watchdog for group ${chrome} outlived the group`).toEqual([]);
  }, 100_000);
});
