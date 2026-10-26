// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1229 r43, judge-120 at 390: the bell's count read "1004" and was drawn over the bell icon. Laid out
// in a real Chrome over the app's stylesheet, because whether one box covers another is a fact of layout.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeChrome, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";
import { measuredAt } from "@/test-support/flat-in-chrome";
import { TopBar } from "./top-bar";

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

interface Bell {
  viewport: number;
  count: string | null;
  /** How far the count's box and the bell icon's box overlap along each axis, in px; 0 where they do not. */
  overlapX: number;
  overlapY: number;
  /** The count's box lies inside the button the bell is. */
  countInsideButton: boolean;
  scrollsSideways: boolean;
}

const MEASURE = `
(function () {
  var button = document.querySelector('button[aria-label="Notifications"]');
  var icon = button.querySelector("svg").getBoundingClientRect();
  var badge = button.querySelector('[data-testid="bell-count"]');
  var b = badge ? badge.getBoundingClientRect() : null;
  var box = button.getBoundingClientRect();
  var doc = document.documentElement;
  return {
    viewport: window.innerWidth,
    count: badge ? badge.textContent : null,
    overlapX: b ? Math.max(0, Math.min(icon.right, b.right) - Math.max(icon.left, b.left)) : 0,
    overlapY: b ? Math.max(0, Math.min(icon.bottom, b.bottom) - Math.max(icon.top, b.top)) : 0,
    countInsideButton: b ? b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom : false,
    scrollsSideways: doc.scrollWidth > doc.clientWidth + 1
  };
})()`;

const bar = (count: number) =>
  renderToStaticMarkup(
    <TopBar
      breadcrumb={[{ label: "Projects", href: "/projects" }, { label: "J120 desk", href: "/projects/j120-desk" }, { label: "Issues" }]}
      notificationCount={count}
      onMenu={() => {}}
      onNotifications={() => {}}
      onCommandPalette={() => {}}
      onAskAgent={() => {}}
      onNewIssue={() => {}}
    />,
  );

describe.each([1280, 390])("the bell's count at %ipx", (viewport) => {
  it.each([7, 99, 1004])("covers no part of the bell icon with %i open", async (open) => {
    const m = await measuredAt<Bell>(bar(open), viewport, MEASURE);
    expect(m.count).toBe(open > 99 ? "99+" : String(open));
    expect(Math.min(m.overlapX, m.overlapY)).toBe(0);
    expect(m.countInsideButton).toBe(true);
    expect(m.scrollsSideways).toBe(false);
  });
});
