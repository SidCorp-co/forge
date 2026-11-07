// A lane reads apart on a phone (ISS-1072 round 3, activity-m on dev.571): at 390 the "15:00" and
// "now" labels printed over each other, and batch circles sat on release diamonds, the marks spread
// for the 590px track a phone does not have. The marks spread over the track as it is laid out, on two
// rows where one line cannot hold them, and the axis prints only the labels its width holds whole.
// @direct-test-of packages/web-v2/src/design/patterns/timeline.tsx

import { describe, expect, it } from "vitest";
import { AXIS_LABEL_PX, axisTicks, MARK_STEP, spreadMarks } from "./timeline";

/** Forge's lane at 15:08 on dev.571: five batches, each with a release minutes after it, over two hours. */
const FORGE = [13.5, 32, 51, 70, 92].flatMap((at, i) => [
  { key: `b${i}`, at, pin: false },
  { key: `r${i}`, at: at + 1.5, pin: false },
]);
const PHONE_TRACK = 160;

/** Where each mark stands on a track `width` px wide, once spread for it: its row and its centre in px. */
const standing = (width: number) => {
  const spots = spreadMarks(FORGE, width);
  return FORGE.map((m) => ({ key: m.key, row: spots.get(m.key)?.lowered ? 1 : 0, px: (m.at * width) / 100 + (spots.get(m.key)?.shift ?? 0) }));
};

describe("marks on a phone's track", () => {
  it.each([PHONE_TRACK, 230, 590, 1100])("never cover each other on a %ipx track", (width) => {
    const marks = standing(width);
    for (const a of marks) {
      for (const b of marks) {
        if (a.key >= b.key || a.row !== b.row) continue;
        expect(Math.abs(a.px - b.px), `${a.key} and ${b.key} on row ${a.row} at ${width}px`).toBeGreaterThanOrEqual(MARK_STEP - 1);
      }
      expect(a.px).toBeGreaterThanOrEqual(0);
      expect(a.px).toBeLessThanOrEqual(width + 0.5);
    }
  });

  it("keeps one line where the track holds every mark, as on the desktop", () => {
    expect(standing(590).every((m) => m.row === 0)).toBe(true);
  });
});

describe("the axis's labels", () => {
  const ticks = [0, 25, 50, 75, 93.3].map((at) => ({ key: String(at), at }));

  it("drops a label eight minutes before now on a 160px axis, where it would print over now", () => {
    const kept = axisTicks(ticks, PHONE_TRACK).map((t) => t.at);
    expect(kept).not.toContain(93.3);
    for (const at of kept) expect(((100 - at) * PHONE_TRACK) / 100).toBeGreaterThanOrEqual(AXIS_LABEL_PX);
    for (let i = 1; i < kept.length; i++) expect((((kept[i] ?? 0) - (kept[i - 1] ?? 0)) * PHONE_TRACK) / 100).toBeGreaterThanOrEqual(AXIS_LABEL_PX);
  });

  it("keeps every half hour on a desktop axis, and one near now where the axis has the room", () => {
    expect(axisTicks(ticks, 900).map((t) => t.at)).toEqual([0, 25, 50, 75, 93.3]);
  });
});
