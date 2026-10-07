import { say, sayEn, verbatim } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { said } from "@/lib/i18n/said";

// A pulse record's detail as core says it (`me/pulse-actions.ts`), read in the interface language.

describe("the workspace Overview reads core's record details", () => {
  it("reads a count and a commit off the live branch in vi, keeping a title, a sha and a branch", () => {
    const waiting = say("overview.record.waiting", { n: 3, issues: "issues" });
    expect(said(waiting, "en")).toBe("3 issues waiting");
    expect(said(say("overview.record.waiting", { n: 1, issues: "issue" }), "en")).toBe("1 issue waiting");
    expect(said(waiting, "vi")).not.toMatch(/waiting/);
    const off = say("overview.record.notOnLive", { title: "Muc", sha: "abcdef12", branch: "prod" });
    expect(said(off, "en")).toBe(sayEn(off));
    expect(said(off, "en")).toBe("Muc · abcdef12 not on prod");
    expect(said(off, "vi")).toMatch(/^Muc · abcdef12 .*prod$/);
    expect(said(off, "vi")).not.toMatch(/not on/);
    expect(said(verbatim("hop"), "vi")).toBe("hop");
  });
});
