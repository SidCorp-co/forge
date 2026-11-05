// A read that has not read a project's decisions yet never empties what the page last knew of them
// (ISS-979 fix round 3: two live reads at 08:16 and 08:17 answered every wait empty and You at 0
// while core was still reading them after a restart).

import type { OrgActivity, OrgActivityProject } from "@forge/contracts/org-activity";
import { describe, expect, it } from "vitest";
import { keepReadWaits } from "./hooks";

const project = (id: string, over: Partial<OrgActivityProject>): OrgActivityProject =>
  ({
    projectId: id,
    slug: id,
    name: id,
    group: "idle",
    people: { total: 0, items: [] },
    peoplePending: false,
    lane: { from: "2026-11-05T06:00:00.000Z", runs: [], batches: [], releases: [], waits: [] },
    ...over,
  }) as OrgActivityProject;

const read = (projects: OrgActivityProject[]): OrgActivity =>
  ({ generatedAt: "2026-11-05T08:17:01.000Z", orgId: "o", projects, refreshing: true, totals: {} }) as unknown as OrgActivity;

const waits = [{ at: "2026-11-05T06:00:00.000Z", items: [], more: 7 }];

describe("keepReadWaits", () => {
  it("keeps a project's last read decisions, group and pins while this read is still reading them", () => {
    const held = read([project("forge", { group: "you", people: { total: 7, items: [] }, lane: { from: "x", runs: [], batches: [], releases: [], waits } })]);
    const fresh = read([project("forge", { peoplePending: true, lane: { from: "y", runs: [], batches: [{ at: "z", moves: [] }], releases: [], waits: [] } })]);
    const kept = keepReadWaits(fresh, held).projects[0];
    expect(kept?.people.total).toBe(7);
    expect(kept?.group).toBe("you");
    expect(kept?.peoplePending).toBe(false);
    expect(kept?.lane.waits).toEqual(waits);
    // everything else is the fresh read's
    expect(kept?.lane.from).toBe("y");
    expect(kept?.lane.batches).toHaveLength(1);
  });

  it("counts the chips over the groups it kept, not the groups the pending read guessed (ISS-979 round 4)", () => {
    const held = read([project("forge", { group: "you", people: { total: 6, items: [] } }), project("eco", { group: "you", people: { total: 1, items: [] } })]);
    // the pending read's own totals: core counted the projects under the groups it guessed
    const fresh: OrgActivity = {
      ...read([project("forge", { group: "working", peoplePending: true }), project("eco", { group: "none", peoplePending: true }), project("agenfold", {})]),
      totals: { projects: 3, you: 0, working: 1, idle: 1, paused: 0, none: 1 },
    };
    const out = keepReadWaits(fresh, held);
    expect(out.totals).toMatchObject({ projects: 3, you: 2, working: 0, idle: 1, none: 0 });
  });

  it("answers the fresh read where it has read everything, and keeps pending where nothing was read before", () => {
    const held = read([project("forge", { group: "you", people: { total: 7, items: [] } })]);
    const fresh = read([project("forge", { people: { total: 2, items: [] } }), project("agenfold", { peoplePending: true })]);
    const out = keepReadWaits(fresh, held);
    expect(out.projects[0]?.people.total).toBe(2);
    expect(out.projects[1]?.peoplePending).toBe(true);
    expect(keepReadWaits(fresh, undefined)).toBe(fresh);
  });
});
