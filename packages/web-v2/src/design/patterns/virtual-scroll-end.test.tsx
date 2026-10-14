// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1264 round 3. A jump to the end of a virtualised list is aimed at estimated row heights, and
// came to rest hundreds of px short (970px on the inbox at 390px); only a second scroll reached the
// last row. The lists run here as the app draws them, in a real Chrome at 390px and 1280px, and
// each jump is read where it comes to rest: the last row in the document, its bottom on the frame's.

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInApp } from "@/test-support/chrome-app";
import { closeChrome, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

const HARNESS = fileURLToPath(new URL("../../test-support/virtual-scroll-harness.tsx", import.meta.url));

interface Landing {
  scrollTop: number;
  farthest: number;
  lastDrawn: boolean;
  shortBy: number | null;
  drawn: number;
  focused: string | null;
}

const JUMPS = [
  { name: "Ctrl+End on a row of the notification feed", scenario: "list-key" },
  { name: "a scroll to the end of the notification feed", scenario: "list-scroll" },
  { name: "a scroll to the end of a DataTable of more than 100 rows", scenario: "table-scroll" },
];
const SCREENS = [390, 1280];
const LONGEST = [40, 120];

describe("a jump to the end lands on the last row the first time", () => {
  for (const { name, scenario } of JUMPS) {
    for (const viewport of SCREENS) {
      for (const longest of LONGEST) {
        it(`${name}, at ${viewport}px with rows up to ${longest} words`, async () => {
          const landing = await runInApp<Landing>(HARNESS, `${scenario}:${longest}`, viewport);
          expect(landing.lastDrawn, `the last row was not in the document: ${JSON.stringify(landing)}`).toBe(true);
          expect(Math.abs(landing.shortBy ?? Number.NaN), `the jump came to rest ${landing.shortBy}px from the last row: ${JSON.stringify(landing)}`).toBeLessThanOrEqual(1);
          expect(landing.scrollTop).toBeGreaterThanOrEqual(landing.farthest - 1);
          expect(landing.drawn).toBeLessThan(60);
        }, 30_000);
      }
    }
  }

  it("leaves focus on the last row after Ctrl+End", async () => {
    const landing = await runInApp<Landing>(HARNESS, "list-key:40", 390);
    expect(landing.focused).toBe("1299");
  });
});
