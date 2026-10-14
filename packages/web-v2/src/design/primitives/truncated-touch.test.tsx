// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1264 round 3. A title is not there for a finger or a keyboard, so text a cell cuts short
// reads whole only on a hover. In a real Chrome at 390px with touch on, a tap on cut text shows all
// of it, Tab reaches it and the accessibility tree names it whole, and text that fits is not a stop.

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withApp } from "@/test-support/chrome-app";
import { closeChrome, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

const HARNESS = fileURLToPath(new URL("../../test-support/truncated-harness.tsx", import.meta.url));
const WHOLE = "Project: qa-project-available-for-testing-0xxxxxx";
const centre = (selector: string) =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const shown = "(() => { const t = document.querySelector('[role=tooltip]'); if (!t) return null; const r = t.getBoundingClientRect(); return { text: t.textContent, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; })()";

describe("text cut short, in a real Chrome at 390px with touch on", () => {
  it("is cut where the page says it is, so the cases below are about cut text", () =>
    withApp(HARNESS, "", 390, async (tab) => {
      await tab.waitFor("window.ready === true", 15_000, "the page to be laid out in the app's fonts");
      expect(await tab.evaluate<boolean>('(() => { const e = document.querySelector("#cut > span"); return e.scrollWidth > e.clientWidth; })()')).toBe(true);
      expect(await tab.evaluate<boolean>('(() => { const e = document.querySelector("#fits > span"); return e.scrollWidth > e.clientWidth; })()')).toBe(false);
    }));

  it("shows the whole text on screen when it is tapped, and takes it away when something else is", () =>
    withApp(HARNESS, "", 390, async (tab) => {
      await tab.waitFor("window.ready === true", 15_000, "the page to be laid out in the app's fonts");
      expect(await tab.evaluate(shown)).toBeNull();
      const at = await tab.evaluate<{ x: number; y: number }>(centre("#cut > span"));
      await tab.tap(at.x, at.y);
      await tab.waitFor("document.querySelector('[role=tooltip]') !== null", 5_000, "the whole text to be shown after a tap");
      expect(await tab.evaluate(shown)).toEqual({ text: WHOLE, inside: true });
      const away = await tab.evaluate<{ x: number; y: number }>(centre("#after"));
      await tab.tap(away.x, away.y);
      await tab.waitFor("document.querySelector('[role=tooltip]') === null", 5_000, "the text to go away when another control is tapped");
    }));

  it("is reached by Tab, named whole by the accessibility tree, and the text that fits is not a stop", () =>
    withApp(HARNESS, "", 390, async (tab) => {
      await tab.waitFor("window.ready === true", 15_000, "the page to be laid out in the app's fonts");
      await tab.pressTab();
      expect(await tab.evaluate("document.activeElement.parentElement.id")).toBe("cut");
      expect(await tab.accessibleName("#cut > span")).toBe(WHOLE);
      expect(await tab.evaluate(shown)).toMatchObject({ text: WHOLE });
      await tab.pressTab();
      expect(await tab.evaluate("document.activeElement.id")).toBe("after");
      expect(await tab.evaluate("document.querySelector('#fits > span').hasAttribute('tabindex')")).toBe(false);
    }));
});
