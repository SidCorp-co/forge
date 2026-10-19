// A mindmap draws its root mid-diagram, so a box opened at its start clipped it (ISS-1229 r8).

/** Mermaid's class for a mindmap's root, the one diagram that does not start at its left edge. */
export const DIAGRAM_ROOT_SELECTOR = ".mindmap-node.section-root";

export interface ScrollBox {
  clientWidth: number;
  scrollWidth: number;
}

export interface RootSpan {
  left: number;
  width: number;
}

export function rootScrollLeft(box: ScrollBox, root: RootSpan | null): number {
  const most = Math.max(0, box.scrollWidth - box.clientWidth);
  if (!root || most === 0) return 0;
  const centred = root.left + root.width / 2 - box.clientWidth / 2;
  return Math.round(Math.min(most, Math.max(0, centred)));
}

export function hiddenSides(box: ScrollBox & { scrollLeft: number }): { start: boolean; end: boolean } {
  const most = box.scrollWidth - box.clientWidth;
  if (most <= 1) return { start: false, end: false };
  return { start: box.scrollLeft > 1, end: box.scrollLeft < most - 1 };
}

/** A fade over each edge that hides more; a mask reads only alpha, so any opaque colour serves. */
export function edgeMask(sides: { start: boolean; end: boolean }): string | undefined {
  if (!sides.start && !sides.end) return undefined;
  const from = sides.start ? "transparent, currentColor 32px" : "currentColor";
  const to = sides.end ? "currentColor calc(100% - 32px), transparent" : "currentColor";
  return `linear-gradient(to right, ${from}, ${to})`;
}
