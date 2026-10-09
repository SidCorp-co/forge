// REQ-31 r2 (ISS-493): the Ask Agent panel opens at the widest width that leaves the page 480px,
// one control switches it to half of that and back, a drag sets any width between, and a width
// saved before the two sizes shipped moves once to large.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCK_SIZE_KEY,
  LARGE_FLOOR,
  LEGACY_DOCK_WIDTH_KEY,
  PAGE_MIN_WIDTH,
  dockSizes,
  dockWidth,
  nextSize,
  settleDockSize,
  sizeAt,
  sizeFromDrag,
} from "./dock-size";

// a 1440px window with the 280px sidebar open leaves the page and the panel 1160px between them
const ROOM = 1160;

describe("the two sizes", () => {
  it("makes large the widest width that leaves the page its 480px, and half half of it", () => {
    expect(PAGE_MIN_WIDTH).toBe(480);
    expect(dockSizes(ROOM)).toEqual({ large: 680, half: 340 });
    expect(ROOM - dockSizes(ROOM).large).toBe(PAGE_MIN_WIDTH);
  });

  it("has no fixed ceiling: a wide window gets a wider large", () => {
    expect(dockSizes(2560 - 280)).toEqual({ large: 1800, half: 900 });
  });

  it("follows the room, so collapsing the sidebar widens both", () => {
    expect(dockSizes(1440 - 88)).toEqual({ large: 872, half: 436 });
  });

  it("never draws large under its floor, however narrow the window", () => {
    expect(dockSizes(700)).toEqual({ large: LARGE_FLOOR, half: LARGE_FLOOR / 2 });
    expect(dockSizes(0).large).toBe(LARGE_FLOOR);
    expect(dockSizes(PAGE_MIN_WIDTH + LARGE_FLOOR + 1).large).toBe(LARGE_FLOOR + 1);
  });

  it("opens a browser that kept nothing at large, not the old 400px", () => {
    expect(dockWidth("large", ROOM)).toBe(680);
    expect(dockWidth("half", ROOM)).toBe(340);
  });
});

describe("a dragged width", () => {
  it("is kept as the px it ended at between the two sizes", () => {
    expect(sizeFromDrag(500.4, ROOM)).toBe(500);
    expect(dockWidth(500, ROOM)).toBe(500);
  });

  it("stops at large past large and at half below half, and then is that size", () => {
    expect(sizeFromDrag(1100, ROOM)).toBe("large");
    expect(sizeFromDrag(680, ROOM)).toBe("large");
    expect(sizeFromDrag(120, ROOM)).toBe("half");
    expect(sizeFromDrag(340, ROOM)).toBe("half");
  });

  it("is held between today's sizes when the window shrinks under it", () => {
    expect(dockWidth(900, ROOM)).toBe(680);
    expect(dockWidth(200, ROOM)).toBe(340);
  });
});

describe("the size control", () => {
  it("reads which size the panel is at, and none for a dragged width", () => {
    expect(sizeAt(680, ROOM)).toBe("large");
    expect(sizeAt(340, ROOM)).toBe("half");
    expect(sizeAt(500, ROOM)).toBeNull();
  });

  it("switches large to half and half to large", () => {
    expect(nextSize(680, ROOM)).toBe("half");
    expect(nextSize(340, ROOM)).toBe("large");
  });

  it("snaps a dragged width to the nearer size, large at the exact middle", () => {
    expect(nextSize(400, ROOM)).toBe("half");
    expect(nextSize(600, ROOM)).toBe("large");
    expect(nextSize(510, ROOM)).toBe("large");
  });
});

function store(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("the width saved before the two sizes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("moves to large on the first open, which is recorded so it never moves again", () => {
    const s = store({ [LEGACY_DOCK_WIDTH_KEY]: "650" });
    expect(settleDockSize(s)).toBe("large");
    expect(s.m.get(DOCK_SIZE_KEY)).toBe('"large"');
    expect(s.m.has(LEGACY_DOCK_WIDTH_KEY)).toBe(false);
  });

  it("is not read on a later open, even when a tab on the old build wrote it again", () => {
    const s = store({ [DOCK_SIZE_KEY]: '"half"', [LEGACY_DOCK_WIDTH_KEY]: "420" });
    expect(settleDockSize(s)).toBe("half");
    expect(s.m.get(DOCK_SIZE_KEY)).toBe('"half"');
  });

  it("leaves a kept dragged width as it is", () => {
    expect(settleDockSize(store({ [DOCK_SIZE_KEY]: "512" }))).toBe(512);
  });

  it("opens a browser that saved nothing at large", () => {
    const s = store();
    expect(settleDockSize(s)).toBe("large");
    expect(s.m.get(DOCK_SIZE_KEY)).toBe('"large"');
  });

  it("names a kept value that is no size, and opens large over it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = store({ [DOCK_SIZE_KEY]: '"huge"' });
    expect(settleDockSize(s)).toBe("large");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"huge"'));
    expect(s.m.get(DOCK_SIZE_KEY)).toBe('"large"');
    expect(settleDockSize(store({ [DOCK_SIZE_KEY]: "-5" }))).toBe("large");
  });
});
