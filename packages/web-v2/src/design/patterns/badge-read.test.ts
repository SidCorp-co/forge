// ISS-1156 — a badge tells a read figure, a read on its way and a read that failed apart, and is
// absent only for a read zero. Each of the four reads a person meets must give a different face.

import { describe, expect, it } from "vitest";
import { badgeFace, badgeFigure } from "./badge-read";

function face(figure: Parameters<typeof badgeFace>[0]) {
  const f = badgeFace(figure);
  if (!f) throw new Error("expected a badge face");
  return f;
}

describe("badgeFigure", () => {
  it("states the count only once every read came in", () => {
    expect(badgeFigure(["read", "read"], 3)).toEqual({ badge: 3 });
    expect(badgeFigure(["read", "read"], 0)).toEqual({ badge: 0 });
  });

  it("says pending while any read is on its way", () => {
    expect(badgeFigure(["pending", "read"], 3)).toEqual({ badgeRead: "pending" });
  });

  it("says failed when any read failed, before a read that is still on its way", () => {
    expect(badgeFigure(["read", "failed"], 3)).toEqual({ badgeRead: "failed" });
    expect(badgeFigure(["pending", "failed"], 3)).toEqual({ badgeRead: "failed" });
  });
});

describe("badgeFace", () => {
  it("shows nothing only for a read zero", () => {
    expect(badgeFace({ badge: 0 })).toBeNull();
    expect(badgeFace({})).toBeNull();
  });

  it("gives a count, a pending read and a failed read a different mark and a different name", () => {
    const count = face({ badge: 20 });
    const pending = face({ badgeRead: "pending" });
    const failed = face({ badgeRead: "failed" });
    expect(new Set([count.text, pending.text, failed.text]).size).toBe(3);
    expect(new Set([count.phrase, pending.phrase, failed.phrase]).size).toBe(3);
    expect(failed.phrase).toBe("how many need attention could not be read");
    expect(count.text).toBe("20");
  });

  it("does not state a count held before a read failed", () => {
    expect(face({ badge: 20, badgeRead: "failed" }).text).not.toBe("20");
  });

  it("caps a count at 99+", () => {
    expect(face({ badge: 230 }).text).toBe("99+");
  });
});
