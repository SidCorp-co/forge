// Where a diagram wider than its box opens, and which of its edges hide more of it. A mindmap draws
// its root in the middle, so a box opened at its start clipped the root at the right edge with
// nothing to say the box scrolled (ISS-1229 r8, judge-20).

/** The class mermaid gives the root node of a mindmap; the one diagram that does not start at its left edge. */
export const DIAGRAM_ROOT_SELECTOR = ".mindmap-node.section-root";

export interface ScrollBox {
  clientWidth: number;
  scrollWidth: number;
}

/** Where the root sits along the scrolled content, in pixels from its start. */
export interface RootSpan {
  left: number;
  width: number;
}

/** The scroll offset that puts the root in the middle of the box, held inside what the box can scroll;
 *  0 where the diagram has no such root, which is where every other diagram begins. */
export function rootScrollLeft(box: ScrollBox, root: RootSpan | null): number {
  const most = Math.max(0, box.scrollWidth - box.clientWidth);
  if (!root || most === 0) return 0;
  const centred = root.left + root.width / 2 - box.clientWidth / 2;
  return Math.round(Math.min(most, Math.max(0, centred)));
}

/** Which edges have more of the diagram past them. A pixel of rounding is not more diagram. */
export function hiddenSides(box: ScrollBox & { scrollLeft: number }): { start: boolean; end: boolean } {
  const most = box.scrollWidth - box.clientWidth;
  if (most <= 1) return { start: false, end: false };
  return { start: box.scrollLeft > 1, end: box.scrollLeft < most - 1 };
}

/** A fade over each edge that hides more, so the box shows it scrolls before anyone tries it. */
export function edgeMask(sides: { start: boolean; end: boolean }): string | undefined {
  if (!sides.start && !sides.end) return undefined;
  const from = sides.start ? "transparent, #000 32px" : "#000";
  const to = sides.end ? "#000 calc(100% - 32px), transparent" : "#000";
  return `linear-gradient(to right, ${from}, ${to})`;
}
