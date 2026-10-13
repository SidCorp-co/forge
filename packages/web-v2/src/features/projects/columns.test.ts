// @vitest-environment jsdom
//
// ISS-1263 — the projects console's sorting and searching live in its column declarations, and the
// cards and the list both take their rows through them. These pin what the console promised before
// the engine moved: the order each sort gives, that a project whose rollup was not read sorts last
// and is never found by what only the rollup knows, and that the needs-attention filter holds only
// what was read to need attention.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DataTableModelOptions } from "@/design";
import { useDataTableRows } from "@/design";
import { DEFAULT_PROJECT_SORT, FIRST_DESC, isDefaultSort, PROJECT_MODEL_COLUMNS, toProjectSort } from "./columns";
import { mergeProjects } from "./derive";
import type { ProjectConsoleItem, ProjectHealthRow, ProjectListItem } from "./types";

const list = (id: string, over: Partial<ProjectListItem> = {}): ProjectListItem => ({
  id, slug: id, name: id, orgId: "o1", orgName: "Org", orgIsPersonal: false, createdBy: "u1",
  role: "admin", orgRole: "owner", apiKey: null, archivedAt: null, createdAt: "2026-10-01T00:00:00Z", ...over,
});
const health = (id: string, over: Partial<ProjectHealthRow> = {}): ProjectHealthRow =>
  ({
    id, projectName: id, projectSlug: id, description: "d", repoPath: "r", throughput: 0, totalActive: 29,
    work: { open: 1, in_flight: 2, awaiting_release: 3, blocked_on_person: 4, draft: 0, finished: 0 },
    blockers: [], blockersTotal: 0, pendingEscalations: 0, avgCycleTimeDays: 0, liveRuns: 2, runnerCount: 1,
    spend24hUsd: 1.5, memberCount: 3, members: ["AB"], lastActivityAt: "2026-10-02T00:00:00Z", ...over,
  }) as ProjectHealthRow;
const none = new Set<string>();

function read(id: string, rollup: Partial<ProjectHealthRow> = {}, over: Partial<ProjectListItem> = {}): ProjectConsoleItem {
  return mergeProjects([list(id, over)], [health(id, rollup)], none, "read")[0] as ProjectConsoleItem;
}
const unread = (id: string, over: Partial<ProjectListItem> = {}): ProjectConsoleItem =>
  mergeProjects([list(id, over)], undefined, none, "failed")[0] as ProjectConsoleItem;
// A project whose rollup was not read but which still carries what an earlier read left on it.
const stale = (id: string, over: Partial<ProjectConsoleItem>): ProjectConsoleItem => ({ ...read(id), healthRead: "failed", ...over });

function ids(items: ProjectConsoleItem[], options: DataTableModelOptions) {
  const { result } = renderHook(() => useDataTableRows(items, PROJECT_MODEL_COLUMNS, options));
  return result.current.map((p) => p.id);
}
const by = (id: "recent" | "name" | "health", desc = FIRST_DESC[id]) => ({ sort: { id, desc } });

describe("the projects console sorts", () => {
  const quiet = { totalActive: 0, liveRuns: 0 };
  const items = [
    read("b", { lastActivityAt: "2026-10-03T00:00:00Z" }, { name: "Bravo" }),
    read("a", { ...quiet, lastActivityAt: "2026-10-09T00:00:00Z" }, { name: "alpha" }),
    read("c", { blockers: [{} as never], lastActivityAt: "2026-10-01T00:00:00Z" }, { name: "Charlie" }),
    read("d", { blockers: [{} as never], lastActivityAt: "2026-10-05T00:00:00Z" }, { name: "delta" }),
  ];

  it("by name, A to Z by locale, so alpha precedes Bravo", () => {
    expect(ids(items, by("name"))).toEqual(["a", "b", "c", "d"]);
  });

  it("by recent activity, newest first", () => {
    expect(ids(items, by("recent"))).toEqual(["a", "d", "b", "c"]);
  });

  it("by health, worst first and the most recent first among equals", () => {
    expect(ids(items, by("health"))).toEqual(["d", "c", "b", "a"]);
  });

  it("the other way round when the header is activated again", () => {
    expect(ids(items, by("name", true))).toEqual(["d", "c", "b", "a"]);
  });

  it("every sort starts the way round its label promises", () => {
    expect(FIRST_DESC).toEqual({ recent: true, name: false, health: false });
    expect(isDefaultSort(DEFAULT_PROJECT_SORT)).toBe(true);
    expect(isDefaultSort({ id: "recent", desc: false })).toBe(false);
  });
});

describe("a project whose rollup was not read", () => {
  it("sorts after every project whose health was read, under the health sort", () => {
    expect(ids([unread("a"), read("b", { totalActive: 0, liveRuns: 0 })], by("health"))).toEqual(["b", "a"]);
  });

  it("stays after every project whose health was read when the health sort runs the other way", () => {
    const items = [unread("a"), stale("s", { health: "down" }), read("b", { totalActive: 0, liveRuns: 0 }), read("c", { blockers: [{} as never] })];
    expect(ids(items, by("health", true)).slice(0, 2)).toEqual(["b", "c"]);
    expect(ids(items, by("health", false)).slice(0, 2)).toEqual(["c", "b"]);
    expect(ids(items, by("health", true)).slice(2).sort()).toEqual(["a", "s"]);
  });

  it("keeps the order it was given under the rollup sorts, whatever stale health or activity it holds", () => {
    const a = stale("a", { health: "healthy", lastActivityAt: "2026-10-01T00:00:00Z" });
    const b = stale("b", { health: "down", lastActivityAt: "2026-10-09T00:00:00Z" });
    for (const id of ["recent", "health"] as const) {
      expect(ids([a, b], by(id))).toEqual(["a", "b"]);
      expect(ids([b, a], by(id))).toEqual(["b", "a"]);
    }
  });

  it("is not held by the needs-attention filter, however it came by a health", () => {
    expect(ids([unread("a")], { filters: { attention: "yes" } })).toEqual([]);
    expect(ids([stale("a", { health: "attention" })], { filters: { attention: "yes" } })).toEqual([]);
    expect(ids([read("a", { blockers: [{} as never] })], { filters: { attention: "yes" } })).toEqual(["a"]);
  });

  it("is searched by name and organization, and not by a repository or description it has not read", () => {
    const item = stale("a", { name: "Alpha", repoPath: "repo/sable", description: "sable things" });
    expect(ids([item], { search: "sable" })).toEqual([]);
    expect(ids([item], { search: "alpha" })).toEqual(["a"]);
    expect(ids([item], { search: "org" })).toEqual(["a"]);
    expect(ids([{ ...item, healthRead: "read" }], { search: "sable" })).toEqual(["a"]);
  });
});

describe("the sort the list reports", () => {
  it("is refused by name when it is not one the console has", () => {
    expect(() => toProjectSort({ id: "spend", desc: true })).toThrow(/cannot sort by "spend".*recent, name and health/);
    expect(toProjectSort({ id: "name", desc: false })).toEqual({ id: "name", desc: false });
  });
});
