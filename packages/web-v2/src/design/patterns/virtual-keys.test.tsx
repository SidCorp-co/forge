// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1264 round 4. End left the browser to scroll to the end of rows only estimated, so a 150-row
// DataTable took five presses at 1280px. Real keys are pressed in a real Chrome, at 1280px and 390px
// with rows of unequal height, and the first press has to land on the last row.

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withApp } from "@/test-support/chrome-app";
import { closeChrome, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

const HARNESS = fileURLToPath(new URL("../../test-support/virtual-keys-harness.tsx", import.meta.url));

interface Landing {
  lastDrawn: boolean;
  shortBy: number | null;
  focused: string | null;
}

const KEYS = [
  { name: "End", key: "End", ctrl: false },
  { name: "Ctrl+End", key: "End", ctrl: true },
];

describe("the first press of End lands on the last row", () => {
  for (const kind of ["table", "list"]) {
    for (const width of [1280, 390]) {
      for (const longest of [40, 120]) {
        for (const { name, key, ctrl } of KEYS) {
          it(`${name} in a ${kind === "table" ? "150-row DataTable" : "1,300-row feed"} at ${width}px, rows up to ${longest} words`, () =>
            withApp(HARNESS, `${kind}:${longest}`, width, async (tab) => {
              await tab.waitFor("window.ready === true", 15_000, "the page to be laid out in the app's fonts");
              await tab.evaluate("window.focusFirst()");
              await tab.press(key, { ctrl });
              await new Promise((later) => setTimeout(later, 1500));
              const landing = await tab.evaluate<Landing>("window.landing()");
              expect(landing.lastDrawn, `the last row was not in the document after one press: ${JSON.stringify(landing)}`).toBe(true);
              expect(Math.abs(landing.shortBy ?? Number.NaN), `one press rested ${landing.shortBy}px from the last row: ${JSON.stringify(landing)}`).toBeLessThanOrEqual(1);
              expect(landing.focused, JSON.stringify(landing)).toBe(kind === "table" ? "0" : "1299");
            }), 30_000);
        }
      }
    }
  }
});
