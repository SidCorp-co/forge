// REQ-31 BC-3 (ISS-494): code that mirrors a breakpoint in JavaScript reads the width the CSS
// breakpoints read: the nearest container named `page`, the window when there is none.

import { afterEach, describe, expect, it, vi } from "vitest";
import { breakpointWidth } from "./breakpoint-width";

const computed = window.getComputedStyle.bind(window);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** body > column (a container named `names`, `width` px wide) > leaf, with getComputedStyle answering for the column. */
function tree(names: string, width: number) {
  const column = document.createElement("div");
  const leaf = document.createElement("span");
  column.append(leaf);
  document.body.append(column);
  vi.restoreAllMocks();
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => (el === column ? ({ containerName: names } as CSSStyleDeclaration) : computed(el)));
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue(new DOMRect(280, 0, width, 900));
  return leaf;
}

describe("the width a breakpoint reads", () => {
  it("is the page column's while the panel makes it the page container", () => {
    expect(breakpointWidth(tree("page", 480))).toBe(480);
    expect(breakpointWidth(tree("sidebar page", 612))).toBe(612);
  });

  it("is the window's where no ancestor is named page", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    expect(breakpointWidth(tree("pager", 480))).toBe(1440);
    expect(breakpointWidth(tree("", 480))).toBe(1440);
  });
});
