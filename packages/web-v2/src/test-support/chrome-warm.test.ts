// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1264 round 2: the first Chrome-backed case paid the stylesheet compile and the browser's first
// launch inside its own 20s test timeout, so main and PRs went red at random. `warmChrome` pays both
// before any case, each on its own clock, and leaves one browser that every case reuses; a slow or
// missing Chrome fails naming the path tried and is never a test that timed out.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromeLaunches, closeChrome, measureReach, warmChrome } from "./chrome-layout";
import { chromeBinary, launchChrome, WARM_HOOK_MS, WARM_LAUNCH_MS, WARM_STYLESHEET_MS, within } from "./chrome-session";

const dir = mkdtempSync(join(tmpdir(), "forge-chrome-warm-test-"));
const SLOW = join(dir, "slow-chrome");
const DELAYED = join(dir, "delayed-chrome");
const LAUNCHES = join(dir, "launches");
const DELAY_MS = 3_000;
beforeAll(() => {
  writeFileSync(SLOW, "#!/bin/sh\nexec sleep 5\n");
  writeFileSync(DELAYED, `#!/bin/sh\necho x >> "${LAUNCHES}"\nsleep ${DELAY_MS / 1000}\nexec "${chromeBinary()}" "$@"\n`);
  chmodSync(SLOW, 0o755);
  chmodSync(DELAYED, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const named = process.env.CHROME_BIN;
afterEach(async () => {
  await closeChrome();
  if (named === undefined) delete process.env.CHROME_BIN;
  else process.env.CHROME_BIN = named;
});

const launchesOf = (_launcher: string) => (existsSync(LAUNCHES) ? readFileSync(LAUNCHES, "utf8").split("\n").filter(Boolean).length : 0);

const markup =
  '<table aria-label="T"><tbody><tr><td class="sticky">row</td><td><button type="button" aria-label="go">go</button></td></tr></tbody></table>';

describe("the clocks the warm-up runs on", () => {
  it("are each shorter than the hook that holds them, so each names itself before the hook times out", () => {
    expect(WARM_LAUNCH_MS + WARM_STYLESHEET_MS).toBeLessThan(WARM_HOOK_MS);
  });

  it("fail a step that never finishes with what it was waiting for, at the clock it was given", async () => {
    await expect(within("Compiling the app stylesheet for the layout tests", 20, new Promise(() => {}))).rejects.toThrow(
      "Compiling the app stylesheet for the layout tests did not finish within 20ms",
    );
  });
});

describe("a Chrome that cannot be used is refused by name", () => {
  it("fails a slow launch with its own message naming Chrome, the path and the clock, not a test timeout", async () => {
    await expect(launchChrome({ chrome: SLOW, launchMs: 300 })).rejects.toThrow(`Chrome at ${SLOW} first launch did not finish within 300ms`);
  });

  it("holds the socket's opening inside the same launch clock, so a stall there is the launch's too", async () => {
    await expect(launchChrome({ chrome: SLOW, launchMs: 100 })).rejects.toThrow("first launch did not finish within 100ms");
  });

  it("fails the same way through warmChrome, so a beforeAll names it", async () => {
    await expect(warmChrome({ chrome: SLOW, launchMs: 300 })).rejects.toThrow(`Chrome at ${SLOW} first launch did not finish within 300ms`);
  });

  it("fails a Chrome that is not there naming the path it tried", async () => {
    const missing = join(dir, "no-such-chrome");
    await expect(launchChrome({ chrome: missing })).rejects.toThrow(`Chrome at ${missing} could not be launched`);
  });

  it("fails a CHROME_BIN that is not a file naming it, never falling through to another Chrome", () => {
    process.env.CHROME_BIN = join(dir, "not-a-file");
    expect(() => chromeBinary()).toThrow(`CHROME_BIN names ${join(dir, "not-a-file")}, which is not a file`);
  });

  it("refuses a measurement taken before the warm-up, naming what to call", async () => {
    await expect(measureReach(markup, 356, 390)).rejects.toThrow("measureReach ran before warmChrome()");
  });
});

describe("the browser is launched once and reused", () => {
  it("is launched once for many measurements", async () => {
    const before = chromeLaunches();
    await warmChrome();
    await measureReach(markup, 356, 390);
    await measureReach(markup, 894, 1280);
    await measureReach(markup, 356, 390);
    expect(chromeLaunches()).toBe(before + 1);
  }, WARM_HOOK_MS);

  it("pays a slow launch once, in the warm-up, and no measurement after it starts another browser", async () => {
    process.env.CHROME_BIN = DELAYED;
    const warmStart = Date.now();
    await warmChrome();
    expect(Date.now() - warmStart).toBeGreaterThanOrEqual(DELAY_MS);
    expect(launchesOf(DELAYED)).toBe(1);
    for (const width of [390, 1280, 390]) await measureReach(markup, width === 390 ? 356 : 894, width);
    expect(launchesOf(DELAYED)).toBe(1);
  }, WARM_HOOK_MS);
});
