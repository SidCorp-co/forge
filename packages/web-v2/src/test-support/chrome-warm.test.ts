// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1264 round 2: the first Chrome-backed case paid the stylesheet compile and the browser's first
// launch inside its own 20s test timeout, so main and PRs went red at random. `warmChrome` pays both
// before any case, each on its own clock; a slow launch fails naming Chrome and the path tried, and
// is never a test that timed out.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WARM_HOOK_MS, WARM_LAUNCH_MS, WARM_STYLESHEET_MS, warmChrome } from "./chrome-layout";

const dir = mkdtempSync(join(tmpdir(), "forge-chrome-warm-test-"));
const SLOW = join(dir, "slow-chrome");
beforeAll(() => {
  writeFileSync(SLOW, "#!/bin/sh\nexec sleep 5\n");
  chmodSync(SLOW, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const named = process.env.CHROME_BIN;
afterEach(() => {
  if (named === undefined) delete process.env.CHROME_BIN;
  else process.env.CHROME_BIN = named;
});

describe("the clocks the warm-up runs on", () => {
  it("are each shorter than the hook that holds them, so each names itself before the hook times out", () => {
    expect(WARM_LAUNCH_MS + WARM_STYLESHEET_MS).toBeLessThan(WARM_HOOK_MS);
  });
});

describe("warmChrome refuses by name", () => {
  it("fails a stylesheet compile that outlasts its clock with what it was waiting for", async () => {
    await expect(warmChrome({ chrome: SLOW, stylesheetMs: 1 })).rejects.toThrow(
      "Compiling the app stylesheet for the layout tests did not finish within 1ms",
    );
  });

  it("fails a slow launch with its own message naming Chrome, the path and the clock, not a test timeout", async () => {
    await expect(warmChrome({ chrome: SLOW, launchMs: 300 })).rejects.toThrow(
      `Chrome at ${SLOW} did not finish its first launch within 300ms`,
    );
  });

  it("fails a Chrome that is not there naming the path it tried", async () => {
    const missing = join(dir, "no-such-chrome");
    await expect(warmChrome({ chrome: missing })).rejects.toThrow(`Chrome at ${missing} could not be launched`);
  });

  it("fails a CHROME_BIN that is not a file naming it, never falling through to another Chrome", async () => {
    process.env.CHROME_BIN = join(dir, "not-a-file");
    await expect(warmChrome({ launchMs: 5_000 })).rejects.toThrow(`CHROME_BIN names ${join(dir, "not-a-file")}, which is not a file`);
  });
});

describe("warmChrome with the real Chrome", () => {
  it("launches it and compiles the stylesheet within the clocks, and a second call is the same warm-up", async () => {
    await warmChrome();
    expect(warmChrome()).toBe(warmChrome());
  }, WARM_HOOK_MS);
});
