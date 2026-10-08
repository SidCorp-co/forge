// ISS-1156 — a badge tells a read figure, a read on its way and a read that failed apart, and is
// absent only for a read zero. Each of the four reads a person meets must give a different face.

import { describe, expect, it } from "vitest";
import { ATTENTION_COUNTS, badgeFace, badgeFigure } from "./badge-read";

function face(figure: Parameters<typeof badgeFace>[0]) {
  const f = badgeFace(figure);
  if (!f) throw new Error("expected a badge face");
  return f;
}

describe("badgeFigure", () => {
  it("states the count only once every read came in", () => {
    expect(badgeFigure(["read", "read"], 3)).toEqual({ badge: 3, badgeCounts: ATTENTION_COUNTS });
    expect(badgeFigure(["read", "read"], 0)).toEqual({ badge: 0, badgeCounts: ATTENTION_COUNTS });
  });

  it("says pending while any read is on its way", () => {
    expect(badgeFigure(["pending", "read"], 3)).toEqual({ badgeRead: "pending", badgeCounts: ATTENTION_COUNTS });
  });

  it("says failed when any read failed, before a read that is still on its way", () => {
    expect(badgeFigure(["read", "failed"], 3)).toEqual({ badgeRead: "failed", badgeCounts: ATTENTION_COUNTS });
    expect(badgeFigure(["pending", "failed"], 3)).toEqual({ badgeRead: "failed", badgeCounts: ATTENTION_COUNTS });
  });
});

describe("badgeFace", () => {
  it("shows nothing only for a read zero", () => {
    expect(badgeFace({ badge: 0 })).toBeNull();
    expect(badgeFace({})).toBeNull();
  });

  it("gives a count, a pending read and a failed read a different mark and a different name", () => {
    const count = face({ badge: 20, badgeCounts: ATTENTION_COUNTS });
    const pending = face({ badgeRead: "pending", badgeCounts: ATTENTION_COUNTS });
    const failed = face({ badgeRead: "failed", badgeCounts: ATTENTION_COUNTS });
    expect(new Set([count.text, pending.text, failed.text]).size).toBe(3);
    expect(new Set([count.phrase, pending.phrase, failed.phrase]).size).toBe(3);
    expect(failed.phrase).toBe("how many need attention could not be read");
    expect(count.text).toBe("20");
  });

  it("names a count by what it counts, never by the attention words unless that is what it counts", () => {
    expect(face({ badge: 29, badgeCounts: "in open work" }).phrase).toBe("29 in open work");
    expect(face({ badge: 10, badgeCounts: ATTENTION_COUNTS }).phrase).toBe("10 need attention");
  });

  it("makes no claim about a figure that does not say what it counts", () => {
    expect(face({ badge: 29 }).phrase).toBe("29");
    expect(face({ badgeRead: "failed" }).phrase).toBe("the count could not be read");
    expect(face({ badgeRead: "pending" }).phrase).toBe("reading the count");
  });

  it("does not state a count held before a read failed", () => {
    expect(face({ badge: 20, badgeRead: "failed" }).text).not.toBe("20");
  });

  it("caps a count at 99+", () => {
    expect(face({ badge: 230 }).text).toBe("99+");
  });
});
