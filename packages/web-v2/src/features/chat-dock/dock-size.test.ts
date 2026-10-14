// REQ-31 r2 (ISS-493): the Ask Agent panel opens at the widest width that leaves the page 480px,
// one control switches it to half of that and back, a drag sets any width between, and a width
// saved before the two sizes shipped moves once to large. Half never goes below 360px, and where
// large is at 360 there is no Half (REQ-31, decided 2026-10-14 on ISS-493).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCK_SIZE_KEY,
  HALF_FLOOR,
  LARGE_FLOOR,
  LEGACY_DOCK_WIDTH_KEY,
  PAGE_MIN_WIDTH,
  dockOverPage,
  dockSizes,
  dockWidth,
  settleDockSize,
  sizeAt,
  sizeFromDrag,
} from "./dock-size";

// a 1440px window with the 280px sidebar open leaves the page and the panel 1160px between them
const ROOM = 1160;

describe("the two sizes", () => {
  it("makes large the widest width that leaves the page its 480px, and half half of it, held at 360px", () => {
    expect(PAGE_MIN_WIDTH).toBe(480);
    expect(dockSizes(ROOM)).toEqual({ large: 680, half: 360, halfOffered: true });
    expect(ROOM - dockSizes(ROOM).large).toBe(PAGE_MIN_WIDTH);
  });

  it("has no fixed ceiling: a wide window gets a wider large", () => {
    expect(dockSizes(2560 - 280)).toEqual({ large: 1800, half: 900, halfOffered: true });
  });

  it("follows the room, so collapsing the sidebar widens both", () => {
    expect(dockSizes(1440 - 88)).toEqual({ large: 872, half: 436, halfOffered: true });
  });

  it("never draws large under its floor, however narrow the window", () => {
    expect(dockSizes(0).large).toBe(LARGE_FLOOR);
    expect(dockSizes(PAGE_MIN_WIDTH + LARGE_FLOOR + 1).large).toBe(LARGE_FLOOR + 1);
  });
});

// REQ-31, decided 2026-10-14 on ISS-493 (question 7f3f19ed, answer a): at 180px the panel's own title
// shrank to nothing and it scrolled sideways, so Half has a 360px floor of its own
describe("half's floor", () => {
  it("is 360px", () => {
    expect(HALF_FLOOR).toBe(360);
  });

  it("is half of large while that is at least 360px", () => {
    // large 720: half is exactly the floor
    expect(dockSizes(PAGE_MIN_WIDTH + 720)).toEqual({ large: 720, half: 360, halfOffered: true });
  });

  it("holds half at 360px where half of large would be narrower, while large is wider", () => {
    // large 718 and 400: half of each is under the floor
    expect(dockSizes(PAGE_MIN_WIDTH + 718)).toEqual({ large: 718, half: 360, halfOffered: true });
    expect(dockSizes(PAGE_MIN_WIDTH + 400)).toEqual({ large: 400, half: 360, halfOffered: true });
    expect(dockSizes(PAGE_MIN_WIDTH + 361)).toEqual({ large: 361, half: 360, halfOffered: true });
  });

  it("offers no half where large is at 360px, the floor they share", () => {
    expect(dockSizes(PAGE_MIN_WIDTH + LARGE_FLOOR)).toEqual({ large: 360, half: 360, halfOffered: false });
    expect(dockSizes(700)).toEqual({ large: 360, half: 360, halfOffered: false });
    expect(dockSizes(0)).toEqual({ large: 360, half: 360, halfOffered: false });
  });

  it("never draws half under 360px, however narrow the window", () => {
    for (const room of [0, 500, 744, 840, 1000, 1199]) {
      expect(dockWidth("half", room)).toBeGreaterThanOrEqual(HALF_FLOOR);
    }
  });

  it("draws a half this browser kept at large where no half is offered, and reads it as large", () => {
    const room = 1024 - 280;
    expect(dockWidth("half", room)).toBe(360);
    expect(sizeAt(dockWidth("half", room), room)).toBe("large");
  });

  it("ends a drag on a window with no half at large", () => {
    const room = 1024 - 280;
    expect(sizeFromDrag(120, room)).toBe("large");
    expect(sizeFromDrag(360, room)).toBe("large");
  });

  it("opens a browser that kept nothing at large, not the old 400px", () => {
    expect(dockWidth("large", ROOM)).toBe(680);
    expect(dockWidth("half", ROOM)).toBe(360);
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
    expect(sizeFromDrag(360, ROOM)).toBe("half");
  });

  it("is held between today's sizes when the window shrinks under it", () => {
    expect(dockWidth(900, ROOM)).toBe(680);
    expect(dockWidth(200, ROOM)).toBe(360);
  });
});

describe("the size control", () => {
  it("reads which size the panel is at, and none for a dragged width", () => {
    expect(sizeAt(680, ROOM)).toBe("large");
    expect(sizeAt(360, ROOM)).toBe("half");
    expect(sizeAt(500, ROOM)).toBeNull();
  });
});

// REQ-31 BC-4 (ISS-494): where the window cannot hold the page's minimum beside the panel at the width
// it is drawn, the panel goes over the page instead of squeezing it
describe("beside the page or over it", () => {
  it("stays beside while the page keeps its 480px, and goes over at one px less", () => {
    expect(dockOverPage(ROOM - PAGE_MIN_WIDTH, ROOM)).toBe(false);
    expect(dockOverPage(ROOM - PAGE_MIN_WIDTH + 1, ROOM)).toBe(true);
    expect(dockOverPage(ROOM - PAGE_MIN_WIDTH - 1, ROOM)).toBe(false);
  });

  it("keeps large and half beside on a window wide enough for both", () => {
    expect(dockOverPage(dockWidth("large", ROOM), ROOM)).toBe(false);
    expect(dockOverPage(dockWidth("half", ROOM), ROOM)).toBe(false);
  });

  it("puts large over the page where its floor leaves the page under its minimum, and judges half on its own width", () => {
    // a 1024px window with the 280px sidebar open: large is held at its 360px floor and would leave
    // 384; there is no half there, and a kept half is drawn at large, so it goes over too
    const room = 1024 - 280;
    expect(dockOverPage(dockWidth("large", room), room)).toBe(true);
    expect(dockOverPage(dockWidth("half", room), room)).toBe(true);
    // a 1200px window: large 440 leaves the page 480, half at its 360px floor leaves 560, both beside
    expect(dockOverPage(dockWidth("large", 1200 - 280), 1200 - 280)).toBe(false);
    expect(dockOverPage(dockWidth("half", 1200 - 280), 1200 - 280)).toBe(false);
    // a 1440px window with the sidebar folded to 88: half 436 leaves the page 916, beside
    expect(dockOverPage(dockWidth("half", 1440 - 88), 1440 - 88)).toBe(false);
  });

  it("judges a dragged width or a board-widened one by the width it is drawn at", () => {
    expect(dockOverPage(dockWidth(700, ROOM), ROOM)).toBe(false);
    expect(dockOverPage(ROOM - 400, ROOM)).toBe(true);
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
