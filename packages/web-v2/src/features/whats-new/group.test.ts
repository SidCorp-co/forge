import { describe, expect, it } from "vitest";
import { entry, feedOf, NOW } from "./fixtures";
import { sectionsOf } from "./group";

const digest = (week: string) => ({
  week,
  title: "Week",
  body: "A summary.",
  version: "0.4.0-dev.91",
  releasedAt: "2026-10-07T00:00:00.000Z",
});

describe("What's new groups by time, never by version", () => {
  const entries = [
    entry("ISS-1", "improved", "2026-10-07T08:00:00Z"),
    entry("ISS-2", "new", "2026-10-07T07:00:00Z"),
    entry("ISS-3", "fixed", "2026-10-06T08:00:00Z"),
    entry("ISS-4", "new", "2026-10-05T08:00:00Z"),
    entry("ISS-5", "fixed", "2026-09-30T08:00:00Z"),
    entry("ISS-6", "improved", "2026-09-22T08:00:00Z"),
  ];

  it("reads Today, Yesterday, This week, then one heading per earlier week, new before improved", () => {
    const sections = sectionsOf(feedOf(entries), NOW);
    expect(sections.map((s) => s.key)).toEqual(["today", "yesterday", "rest-of-week", "2026-W40", "2026-W39"]);
    expect(sections[0]?.entries.map((e) => e.key)).toEqual(["ISS-2", "ISS-1"]);
    expect(sections[2]?.label.key).toBe("whatsNew.group.thisWeek");
    expect(sections[3]?.label).toEqual({ key: "whatsNew.group.week", date: new Date("2026-09-28T00:00:00Z") });
  });

  it("puts this week's digest on top under This week, and an earlier week's on top of its own heading", () => {
    const sections = sectionsOf(feedOf(entries, { digests: [digest("2026-W41"), digest("2026-W40")] }), NOW);
    expect(sections.map((s) => s.key)).toEqual(["this-week", "today", "yesterday", "rest-of-week", "2026-W40", "2026-W39"]);
    expect(sections[0]?.digest?.week).toBe("2026-W41");
    expect(sections[3]?.label.key).toBe("whatsNew.group.earlierThisWeek");
    expect(sections[4]?.digest?.week).toBe("2026-W40");
  });

  it("narrows to one kind and drops a heading left empty", () => {
    const sections = sectionsOf(feedOf(entries), NOW, "fixed");
    expect(sections.map((s) => [s.key, s.entries.map((e) => e.key)])).toEqual([
      ["yesterday", ["ISS-3"]],
      ["2026-W40", ["ISS-5"]],
    ]);
  });
});
