import { NO_MASTER_SLOTS, slotsNoteSaid } from "@forge/contracts/master-standing";
import { say, sayEn } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { said } from "@/lib/i18n/said";

// Core's own sentences on the Development overview, read from what it said: a signal it cannot read
// (`development/overview-read.ts`) and the slots no live master declared (contracts `master-standing.ts`).

describe("the Development overview reads core's own sentences", () => {
  const notes = [say("overview.signal.ciNote"), say("overview.signal.postMergeNote"), say("overview.signal.noSlotsNote")];

  it("spells each signal note in en as core sends it, and reads it in vi", () => {
    for (const n of notes) {
      expect(said(n, "en")).toBe(sayEn(n));
      expect(said(n, "vi")).not.toBe(sayEn(n));
    }
    expect(sayEn(say("overview.signal.noSlotsNote"))).toBe(NO_MASTER_SLOTS);
  });

  it("carries a box's own refusal of its slots as the box wrote it", () => {
    const s = slotsNoteSaid({ slots: { inUse: 0, max: 0, runs: 0, undeclared: { code: "X", detail: "box says no" } } as never });
    expect(s && said(s, "vi")).toBe("box says no");
    expect(slotsNoteSaid({ slots: null })).toEqual(say("overview.signal.noSlotsNote"));
  });
});
