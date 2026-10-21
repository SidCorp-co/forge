// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1228 round 24 (the master's read of judge-78's shots): with "Its session could not be read" in
// the action toolbar, the title squeezed to about 250px at 1280 and wrapped to three lines, and at 390
// the actions broke into four rows. In a real Chrome the sentence now sits on the header's own line
// under the title and actions, and the title and the toolbar measure as they do with no failure.

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withApp } from "@/test-support/chrome-app";
import { closeChrome, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

const HARNESS = fileURLToPath(new URL("../../../test-support/issue-header-harness.tsx", import.meta.url));

interface Laid {
  titleWidth: number;
  titleLines: number;
  headerHeight: number;
  actionRows: number;
  failureBelowActions: boolean | null;
}

const MEASURE = `(() => {
  const box = (el) => el.getBoundingClientRect();
  const title = document.querySelector("h1, h2");
  const line = parseFloat(getComputedStyle(title).lineHeight);
  const controls = [...document.querySelectorAll('[data-header="actions"] > *')].filter((c) => box(c).width > 0);
  // Controls of unequal height share a row by their centre line, which items-center aligns.
  const rows = new Set(controls.map((c) => Math.round((box(c).top + box(c).bottom) / 2)));
  const actions = document.querySelector('[data-header="actions"]');
  const failure = document.querySelector('[data-header="failure"]');
  return {
    titleWidth: Math.round(box(title).width),
    titleLines: Math.round(box(title).height / line),
    headerHeight: Math.round(box(document.querySelector(".sticky")).height),
    actionRows: rows.size,
    failureBelowActions: failure ? box(failure).top >= box(actions).bottom - 1 : null,
  };
})()`;

function laidOut(scenario: string, width: number): Promise<Laid> {
  return withApp(HARNESS, scenario, width, async (tab) => {
    await tab.waitFor("window.ready === true", 15_000, "the header to be laid out in the app's fonts");
    return tab.evaluate<Laid>(MEASURE);
  });
}

describe("the issue header with a failed read, in a real Chrome", () => {
  it.each([1280, 390])("keeps the title's width and the toolbar's one row at %ipx, the sentence on a line under both", async (width) => {
    const clear = await laidOut("none", width);
    const failed = await laidOut("failed", width);
    expect(failed.titleWidth).toBe(clear.titleWidth);
    expect(failed.titleLines).toBe(clear.titleLines);
    expect(failed.actionRows).toBe(1);
    expect(clear.actionRows).toBe(1);
    expect(failed.failureBelowActions).toBe(true);
  });

  // The measurement goes red on the layout round 23 drew: the same sentence inside the toolbar.
  it("would read the round 23 layout as the defect it was", async () => {
    const clear = await laidOut("none", 1280);
    const inToolbar = await laidOut("in-toolbar", 1280);
    expect(inToolbar.titleWidth).toBeLessThan(clear.titleWidth - 200);
    const phone = await laidOut("in-toolbar", 390);
    expect(phone.actionRows).toBeGreaterThan(1);
  });
});
