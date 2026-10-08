import { NO_MASTER_SLOTS, slotsNoteSaid } from "@forge/contracts/master-standing";
import { say, sayEn } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { said } from "@/lib/i18n/said";

// Core's own sentences on the Development overview, read from what it said: a signal it cannot read
// (`development/overview-read.ts`) and the slots no live master declared (contracts `master-standing.ts`),
// the refusal of a box's undeclared slots included (`masters/rules.ts:undeclaredSlots`).

describe("the Development overview reads core's own sentences", () => {
  const notes = [say("overview.signal.ciNote"), say("overview.signal.postMergeNote"), say("overview.signal.noSlotsNote")];

  it("spells each signal note in en as core sends it, and reads it in vi", () => {
    for (const n of notes) {
      expect(said(n, "en")).toBe(sayEn(n));
      expect(said(n, "vi")).not.toBe(sayEn(n));
    }
    expect(sayEn(say("overview.signal.noSlotsNote"))).toBe(NO_MASTER_SLOTS);
  });

  it("reads core's refusal of a box's undeclared slots by its key, in vi too", () => {
    const detail = say("masters.refusal.slotsNotDeclared", { device: "box-1" });
    const s = slotsNoteSaid({ slots: { inUse: 0, max: 0, runs: 0, undeclared: { code: "MASTER_SLOTS_UNDECLARED", path: "/slots/max", detail: sayEn(detail), says: { detail } } } as never });
    expect(s).toEqual(detail);
    expect(s && said(s, "vi")).not.toBe(sayEn(detail));
    expect(s && said(s, "vi")).toContain("box-1");
    expect(slotsNoteSaid({ slots: null })).toEqual(say("overview.signal.noSlotsNote"));
  });
});
