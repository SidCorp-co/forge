// The Ask Agent panel's two sizes and every width it is drawn at (REQ-31 r2). Large is the widest the
// panel can be while the page beside it keeps its readable minimum; half is half of that; a drag sets
// any width between them, and the size control snaps back to one of the two.

/** The page's readable minimum beside the Ask Agent panel (REQ-31 BC-1, BC-3, BC-4). The panel's
 *  large size leaves the page this much; the page's reflow and the narrow-window overlay read it here. */
export const PAGE_MIN_WIDTH = 480;

/** The narrowest the large size is drawn. Under a window this cannot hold beside the page's minimum,
 *  the page gets less than PAGE_MIN_WIDTH: the too-narrow case REQ-31 BC-4 gives the overlay. */
export const LARGE_FLOOR = 360;

/** What a browser keeps: one of the two sizes, which follows the window, or a dragged width in px. */
export type DockSize = "large" | "half" | number;

export const DOCK_SIZE_KEY = "web-v2:chat-dock-size";
/** Where the panel's dragged px width was kept before the two sizes; read by nothing but the move. */
export const LEGACY_DOCK_WIDTH_KEY = "web-v2:chat-dock-width";

/** `room` is the width the page and the panel share: from the page's left edge to the window's right. */
export function dockSizes(room: number): { large: number; half: number } {
  const large = Math.round(Math.max(LARGE_FLOOR, room - PAGE_MIN_WIDTH));
  return { large, half: Math.round(large / 2) };
}

/** The px width a kept size is drawn at in `room`; a dragged width outside today's two sizes is held to them. */
export function dockWidth(size: DockSize, room: number): number {
  const { large, half } = dockSizes(room);
  if (size === "large") return large;
  if (size === "half") return half;
  return Math.round(Math.min(large, Math.max(half, size)));
}

/** What a drag that ends at `px` keeps: held between the two sizes, and landing on either is that size. */
export function sizeFromDrag(px: number, room: number): DockSize {
  const { large, half } = dockSizes(room);
  const w = Math.round(px);
  if (w >= large) return "large";
  if (w <= half) return "half";
  return w;
}

/** Which of the two sizes `width` is, or null for a width a drag left between them. */
export function sizeAt(width: number, room: number): "large" | "half" | null {
  const { large, half } = dockSizes(room);
  if (width === large) return "large";
  if (width === half) return "half";
  return null;
}

/** Where the size control moves the panel from `width`: large and half swap, a dragged width snaps to the nearer. */
export function nextSize(width: number, room: number): "large" | "half" {
  const { large, half } = dockSizes(room);
  const at = sizeAt(width, room);
  if (at) return at === "large" ? "half" : "large";
  return width - half < large - width ? "half" : "large";
}

const isDockSize = (v: unknown): v is DockSize =>
  v === "large" || v === "half" || (typeof v === "number" && Number.isFinite(v) && v > 0);

type SizeStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The size this browser keeps. The first open after the two sizes shipped finds no DOCK_SIZE_KEY: it
 * moves whatever width was saved under the old key to large (REQ-31 BC-5), writes that, and removes
 * the old key. Once DOCK_SIZE_KEY exists the old key is never read again, so a tab still on the old
 * build writing it cannot move the person a second time.
 */
export function settleDockSize(store: SizeStore): DockSize {
  const raw = store.getItem(DOCK_SIZE_KEY);
  if (raw !== null) {
    const kept = parse(raw);
    if (isDockSize(kept)) return kept;
    console.warn(`${DOCK_SIZE_KEY} holds ${raw}, which is not "large", "half" or a width in px; the panel opens large`);
  }
  store.setItem(DOCK_SIZE_KEY, JSON.stringify("large"));
  store.removeItem(LEGACY_DOCK_WIDTH_KEY);
  return "large";
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
