// ISS-1156 — the console states a figure from the health rollup only where that rollup was read.
// Before it, or after it failed, every figure is null and the health is null: a zero here would be
// the face of a project with no work, and a reader would draw it as one.

import { describe, expect, it } from "vitest";
import { blindSearchEmpty, isAttention, mergeProjects, unreadStatements, workspaceTotals } from "./derive";
import type { ProjectHealthRow, ProjectListItem } from "./types";

const list = (id: string): ProjectListItem => ({
  id, slug: id, name: id, orgId: "o1", orgName: "Org", orgIsPersonal: false, createdBy: "u1",
  role: "admin", orgRole: "owner", apiKey: null, archivedAt: null, createdAt: "2026-10-01T00:00:00Z",
});
const row = (id: string, over: Partial<ProjectHealthRow> = {}): ProjectHealthRow =>
  ({
    id, projectName: id, projectSlug: id, description: "d", repoPath: "r", throughput: 0, totalActive: 29,
    work: { open: 1, in_flight: 2, awaiting_release: 3, blocked_on_person: 4, draft: 0, finished: 0 },
    blockers: [], blockersTotal: 0, pendingEscalations: 0, avgCycleTimeDays: 0, liveRuns: 2, runnerCount: 1,
    spend24hUsd: 1.5, memberCount: 3, members: ["AB"], lastActivityAt: "2026-10-02T00:00:00Z", ...over,
  }) as ProjectHealthRow;
const none = new Set<string>();

describe("mergeProjects", () => {
  it("states the rollup's figures and a health only where the health read came in", () => {
    const [p] = mergeProjects([list("a")], [row("a")], none, "read");
    expect(p).toMatchObject({ healthRead: "read", health: "healthy", liveRuns: 2, openIssues: 29, runnerCount: 1, spend24hUsd: 1.5, memberCount: 3, members: ["AB"] });
  });

  it("states zeros for a project the read rollup has no row for: a project just created has none", () => {
    const [p] = mergeProjects([list("a")], [], none, "read");
    expect(p).toMatchObject({ healthRead: "read", health: "idle", liveRuns: 0, openIssues: 0, runnerCount: 0, spend24hUsd: 0, memberCount: 0 });
  });

  it.each(["pending", "failed"] as const)("states no figure and no health while the health read is %s", (read) => {
    const [p] = mergeProjects([list("a")], undefined, none, read);
    expect(p.healthRead).toBe(read);
    expect(p.health).toBeNull();
    for (const f of [p.liveRuns, p.openIssues, p.runnerCount, p.spend24hUsd, p.memberCount]) expect(f).toBeNull();
  });

  it("states nothing from rows it still holds after a refetch failed over them", () => {
    const [p] = mergeProjects([list("a")], [row("a")], none, "failed");
    expect(p.openIssues).toBeNull();
    expect(p.health).toBeNull();
    expect(p.members).toEqual([]);
    expect(p.lastActivityAt).toBeNull();
  });
});

describe("workspaceTotals", () => {
  it("sums the figures where the rollup was read", () => {
    const items = mergeProjects([list("a"), list("b")], [row("a"), row("b", { totalActive: 1, liveRuns: 0 })], none, "read");
    expect(workspaceTotals(items, "read")).toEqual({ projects: 2, healthRead: "read", liveRuns: 2, openIssues: 30, runners: 2, spend24hUsd: 3 });
  });

  it.each(["pending", "failed"] as const)("states no figure where the rollup is %s, and still counts the projects", (read) => {
    const items = mergeProjects([list("a"), list("b")], undefined, none, read);
    expect(workspaceTotals(items, read)).toEqual({ projects: 2, healthRead: read, liveRuns: null, openIssues: null, runners: null, spend24hUsd: null });
  });
});

describe("a project whose health is unread", () => {
  it("is not one that needs attention", () => {
    expect(isAttention(mergeProjects([list("a")], undefined, none, "failed")[0])).toBe(false);
  });

  it("is not one that needs attention, however it came by a health", () => {
    const item = { ...mergeProjects([list("a")], [row("a")], none, "read")[0], healthRead: "failed" as const, health: "attention" as const };
    expect(isAttention(item)).toBe(false);
    expect(isAttention({ ...item, healthRead: "read" })).toBe(true);
  });
});

describe("unreadStatements", () => {
  const base = { query: "", attentionOnly: false, sort: "name" as const };

  it("says nothing where the rollup is read, whatever is asked of it", () => {
    expect(unreadStatements({ query: "org/sable", attentionOnly: true, sort: "health", read: "read" })).toEqual([]);
  });

  it("says nothing about what is not asked: a name sort with no search and no filter", () => {
    expect(unreadStatements({ ...base, read: "failed" })).toEqual([]);
    expect(unreadStatements({ ...base, read: "pending" })).toEqual([]);
  });

  it.each(["pending", "failed"] as const)("names the search, the attention filter and each rollup sort that cannot be answered while %s", (read) => {
    const says = unreadStatements({ query: "org/sable", attentionOnly: true, sort: "recent", read });
    expect(says).toHaveLength(3);
    expect(says[0]).toMatch(/search matches names and organizations only/);
    expect(says[1]).toMatch(/needs-attention filter is paused/);
    expect(says[2]).toMatch(/not sorted by recent activity/);
    expect(unreadStatements({ ...base, sort: "health", read })[0]).toMatch(/not sorted by health/);
  });

  it("tells a failed read from one on its way", () => {
    const f = unreadStatements({ ...base, query: "x", read: "failed" })[0];
    const p = unreadStatements({ ...base, query: "x", read: "pending" })[0];
    expect(f).toMatch(/could not be read/);
    expect(p).not.toMatch(/could not be read/);
  });

  it("answers a search that matched no name as unanswerable, never as no match", () => {
    expect(blindSearchEmpty(" org/sable ", "failed")).toMatch(/^Cannot say which projects match "org\/sable".*could not be read/);
    expect(blindSearchEmpty("org/sable", "pending")).toMatch(/^Cannot say yet which projects match "org\/sable".*still being read/);
    expect(blindSearchEmpty("org/sable", "failed")).not.toMatch(/No projects match/);
  });
});
