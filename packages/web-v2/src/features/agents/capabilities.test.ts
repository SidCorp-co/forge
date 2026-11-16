// ISS-1251 §5, §7: a door no agent called over the window stands unused whatever else it has, never
// neutral; a landing that touched a card's lesson owes it a re-check; a door refused on a quarter of
// its calls, or reported, is used badly; a called door with no card is untaught. Callers read as the
// audiences a card teaches.

import type { CapabilityLessonRow } from "@forge/contracts/capabilities";
import type { CapabilityCard } from "@forge/contracts/capability-cards";
import type { DoorUseRow } from "@forge/contracts/door-use";
import { describe, expect, it } from "vitest";
import { callerOf, callsByCaller, capDoorsOf, codeWords, standingCounts, standingOf } from "./capabilities";

const card = { id: "support.member", owner: "support", purpose: "Records who a member is", situations: [{ when: "a stranger writes", do: "read who they are" }], practice: ["read first"], audience: ["bot"], scenarios: [] } as CapabilityCard;

const door = (over: Partial<DoorUseRow> = {}): DoorUseRow => ({
  door: "support.member",
  surface: "mcp",
  summary: "records who a member is",
  feature: "forge_support",
  card,
  tiers: { bot: 0 },
  calls: 8,
  refused: 0,
  refusedBy: {},
  byAgent: { "room:support": 8 },
  lastAt: "2026-11-15T00:00:00.000Z",
  ...over,
});

const lesson = (over: Partial<CapabilityLessonRow> = {}): CapabilityLessonRow => ({
  card: "support.member",
  number: 7,
  sentence: "Read a member before replying",
  status: "approved",
  invalid: false,
  invalidBy: null,
  applied: 2,
  lastAppliedAt: null,
  ...over,
});

const report = { door: "support.member", reports: 1, byVerdict: { unclear: 1 }, lastAt: "2026-11-15T00:00:00.000Z" };

describe("where a door stands", () => {
  it("is unused at zero calls, even taught, reported and with an invalid lesson", () => {
    expect(standingOf(door({ calls: 0, byAgent: {} }), report, [lesson({ invalid: true })])).toBe("unused");
  });

  it("owes a re-check where a landing touched one of its card's lessons, or its card", () => {
    expect(standingOf(door(), null, [lesson(), lesson({ number: 8, invalid: true })])).toBe("recheck");
    expect(standingOf(door(), null, [], { card: "support.member", recheckOwed: { since: "2026-11-16T00:00:00.000Z" }, scenarios: [], proposed: [] })).toBe("recheck");
    expect(standingOf(door(), null, [], { card: "support.member", recheckOwed: null, scenarios: [], proposed: [] })).toBe("inUse");
  });

  it("is used badly at a quarter of its calls refused, or one report; just under a quarter is not", () => {
    expect(standingOf(door({ calls: 8, refused: 2 }), null, [])).toBe("misused");
    expect(standingOf(door({ calls: 9, refused: 2 }), null, [])).toBe("inUse");
    expect(standingOf(door(), report, [])).toBe("misused");
  });

  it("is untaught when called with no card, and in use when called and taught", () => {
    expect(standingOf(door({ card: null }), null, [])).toBe("untaught");
    expect(standingOf(door(), null, [])).toBe("inUse");
  });

  it("joins each door with its own reports and lessons and counts every standing", () => {
    const doors = capDoorsOf([door(), door({ door: "support.rule", calls: 0, byAgent: {} })], {
      projectId: "p",
      window: { days: 30, since: "", until: "" },
      feedback: [report],
      lessons: [lesson()],
      freshness: [],
      limits: [],
    });
    expect(doors.map((d) => [d.row.door, d.standing, d.lessons.length])).toEqual([
      ["support.member", "misused", 1],
      ["support.rule", "unused", 0],
    ]);
    expect(standingCounts(doors)).toEqual({ unused: 1, recheck: 0, misused: 1, untaught: 0, inUse: 0 });
  });
});

describe("who called", () => {
  it("reads a room as the bot, a master session as the master, a checkout and a run session as a run", () => {
    expect(["room:support", "session:master", "checkout", "session:run_session", "box", "person"].map(callerOf)).toEqual(["bot", "master", "run", "run", "box", "other"]);
    expect(callsByCaller({ "room:support": 2, "room:operations": 1, steward: 4 })).toEqual({ bot: 3, master: 0, run: 0, box: 0, other: 4 });
  });

  it("says a refusal code in words", () => {
    expect(codeWords("SUPPORT_ACT_DENIED")).toBe("Support act denied");
    expect(codeWords("not_found")).toBe("Not found");
  });
});
