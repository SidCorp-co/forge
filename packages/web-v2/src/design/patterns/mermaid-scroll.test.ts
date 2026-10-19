// ISS-1229 r8, judge-20: the forge-dev Mindmap opened at its start, its root clipped at the right
// edge of an 862px box, with nothing to say the box scrolled.

import { describe, expect, it } from "vitest";
import { edgeMask, hiddenSides, rootScrollLeft } from "./mermaid-scroll";

describe("where a wide diagram opens", () => {
  // The Mindmap as judge-20 measured it at 1280: content 1637px wide, box 862px, root mid-way.
  const box = { clientWidth: 862, scrollWidth: 1637 };
  const root = { left: 760, width: 120 };

  it("centres a root drawn in the middle, so it is in view", () => {
    const left = rootScrollLeft(box, root);
    expect(left).toBe(389);
    expect(root.left - left).toBeGreaterThanOrEqual(0);
    expect(root.left + root.width - left).toBeLessThanOrEqual(box.clientWidth);
  });

  it("does the same in a 324px box at 390 wide", () => {
    const narrow = { clientWidth: 324, scrollWidth: 1637 };
    const left = rootScrollLeft(narrow, root);
    expect(root.left - left).toBeGreaterThanOrEqual(0);
    expect(root.left + root.width - left).toBeLessThanOrEqual(narrow.clientWidth);
  });

  it("holds the offset inside what the box can scroll", () => {
    expect(rootScrollLeft(box, { left: 1600, width: 30 })).toBe(775);
    expect(rootScrollLeft(box, { left: 10, width: 30 })).toBe(0);
  });

  it("opens at the start where the diagram has no such root, or nothing to scroll", () => {
    expect(rootScrollLeft(box, null)).toBe(0);
    expect(rootScrollLeft({ clientWidth: 900, scrollWidth: 900 }, root)).toBe(0);
  });
});

describe("which edges hide more of the diagram", () => {
  const at = (scrollLeft: number) => hiddenSides({ clientWidth: 862, scrollWidth: 1637, scrollLeft });

  it("names the end at the start, both in the middle, and the start at the end", () => {
    expect(at(0)).toEqual({ start: false, end: true });
    expect(at(389)).toEqual({ start: true, end: true });
    expect(at(775)).toEqual({ start: true, end: false });
  });

  it("names neither for a diagram that fits, a pixel of rounding included", () => {
    expect(hiddenSides({ clientWidth: 862, scrollWidth: 863, scrollLeft: 0 })).toEqual({ start: false, end: false });
  });

  it("fades only an edge that hides more, and nothing where none does", () => {
    expect(edgeMask({ start: false, end: true })).toBe("linear-gradient(to right, currentColor, currentColor calc(100% - 32px), transparent)");
    expect(edgeMask({ start: true, end: false })).toBe("linear-gradient(to right, transparent, currentColor 32px, currentColor)");
    expect(edgeMask({ start: false, end: false })).toBeUndefined();
  });
});
