// The module map as core's reads answer it for a project shaped like the mockup (MK-11): a pillar of
// four business modules and the Unplaced row, Execution's tree with the term Run slots, its rules and
// capability, and a find for "chia slot" that finds Run slots by its Vietnamese name. The map's tests
// and its witness read it.

import type { FindResult } from "@forge/contracts/find";
import type { ModuleMapCounts, ModuleMapNode, ModulePillarResponse, ModuleTreeResponse } from "@forge/contracts/module-map";

export const MAP_PROJECT = "7f1c1d1e-0000-4000-8000-000000001256";
const AT = "2026-11-16T09:00:00.000Z";

const counts = (term: number, rule: number, capability: number, requirement: number, decision: number, reference: number): ModuleMapCounts => ({
  term,
  rule,
  capability,
  requirement,
  decision,
  reference,
  knowledge: 0,
  lesson: 0,
});
const mod = (slug: string, name: string) => ({ id: `m-${slug}`, slug, name, path: slug });

export const PILLAR: ModulePillarResponse = {
  generatedAt: AT,
  branches: ["term", "rule", "capability", "requirement", "decision", "reference"],
  modules: [
    { module: mod("execution", "Execution"), description: "Agents, runs, masters, runners and schedules", counts: counts(7, 9, 24, 6, 4, 1), openIssues: 3 },
    { module: mod("work-delivery", "Work & delivery"), description: "Issues, pipeline, phases and landing", counts: counts(5, 11, 31, 14, 6, 0), openIssues: 2 },
    { module: mod("release-deploy", "Release & deploy"), description: null, counts: counts(0, 4, 9, 3, 2, 0), openIssues: 0 },
    { module: mod("adapters", "Adapters"), description: "Providers Forge talks to", counts: counts(0, 0, 11, 0, 0, 0), openIssues: 0 },
  ],
  unplaced: {
    counts: counts(1, 2, 3, 97, 0, 0),
    openIssues: 412,
    items: [
      { type: "term", ref: "steward-budget", title: "Steward budget" },
      { type: "requirement", ref: "REQ-12", title: "A release is cut on a green suite" },
      { type: "issue", ref: "ISS-1200", title: "The board loses its filter on reload" },
    ],
  },
};

const node = (over: Partial<ModuleMapNode> & Pick<ModuleMapNode, "type" | "ref" | "title">): ModuleMapNode => ({
  summary: null,
  module: "execution",
  status: null,
  writtenBy: { agency: "agent" },
  relations: [],
  recheck: null,
  reads: 0,
  ...over,
});

const rel = (kind: ModuleMapNode["relations"][number]["kind"], direction: "out" | "in", type: ModuleMapNode["relations"][number]["other"]["type"], ref: string, title: string | null, module: string | null) => ({
  id: `r-${kind}-${ref}`,
  kind,
  direction,
  other: { type, ref, title, module },
  writtenBy: { name: "orchestrator", agency: "agent" as const },
  at: AT,
});

export const RUN_SLOTS = node({
  type: "term",
  ref: "run-slots",
  title: "Run slots",
  summary: "How many runs a runner box runs at once, shared out between projects",
  module: "execution/devices",
  aliases: { vi: ["chia slot"], industry: ["fair-share scheduling"] },
  namedBy: { who: "owner", quote: "call it run slots" },
  relations: [
    rel("used_in", "out", "rule", "one-slot-minimum", "A project with work keeps at least one slot", "execution"),
    rel("used_in", "out", "capability", "run.declare", "forge-runner run declare", "execution"),
    rel("from", "out", "decision", "c-owner-1116", "Steward follows the work", "work-delivery"),
    rel("anchored_at", "out", "code", "packages/core/src/devices/run-slots.ts:slotsFor", null, null),
  ],
  reads: 14,
});

export const TREE: ModuleTreeResponse = {
  module: {
    ...mod("execution", "Execution"),
    description: "Agents, runs, masters, runners and schedules",
    parent: null,
    children: [mod("devices", "Devices"), mod("runs", "Runs")].map((m) => ({ ...m, path: `execution/${m.slug}` })),
  },
  branches: {
    term: [
      RUN_SLOTS,
      // a term whose other names run past a phone's width on one line, as forge-dev's Room sandbox's do
      node({
        type: "term",
        ref: "room-sandbox",
        title: "Room sandbox",
        summary: "Each room agent runs its background session inside a long-lived bubblewrap sandbox of its own",
        // one code name as long as the path it lives at: a line wider than a phone in few words
        aliases: { code: ["packages/runner/crates/runner-workspace/src/bg_session/room.rs:Host"] },
      }),
    ],
    rule: [
      node({
        type: "rule",
        ref: "one-slot-minimum",
        title: "A project with work keeps at least one slot",
        status: "active",
        relations: [rel("used_in", "in", "term", "run-slots", "Run slots", "execution/devices"), rel("governs", "out", "capability", "run.declare", "forge-runner run declare", "execution"), rel("governs", "out", "requirement", "REQ-48 BC-2", "An agent stands at every handoff", "execution")],
        recheck: { since: AT, by: "dev.692", matched: ["packages/core/src/devices/run-slots.ts:slotsFor"] },
        reads: 6,
      }),
      node({ type: "rule", ref: "steward-daily-cap", title: "The steward spends ten jobs a day", status: "deprecated" }),
    ],
    capability: [node({ type: "capability", ref: "run.declare", title: "forge-runner run declare", reads: 31 })],
    requirement: [node({ type: "requirement", ref: "REQ-48", title: "An agent stands at every handoff", status: "agreed" })],
    decision: [],
    reference: [node({ type: "reference", ref: "src-orca", title: "stablyai/orca", summary: "Parallel agents, one worktree each" })],
  },
  inFlight: [{ key: "ISS-1255", title: "The steward spends a fixed budget", status: "in_progress", module: "execution" }],
  openIssues: 3,
  readsWindowDays: 30,
  generatedAt: AT,
};

/** The term's knowledge row id: a find hit names a term by it, the tree by its slug. */
export const RUN_SLOTS_ROW = "e7c9d109-3a35-413e-b340-e772c78e695a";

// as core's find answers a term: its ref the knowledge row id, its key the slug the tree keys it by
export const RUN_SLOTS_HIT = {
  id: `term:${RUN_SLOTS_ROW}`,
  type: "term" as const,
  ref: RUN_SLOTS_ROW,
  key: "run-slots",
  title: "Run slots",
  excerpt: "How many runs a runner box runs at once",
  projectSlug: "hop",
  module: { slug: "execution", name: "Execution", path: "execution/devices" },
  status: "active",
  path: ["Execution", "Terms"] as [string, string],
  match: { arms: ["alias" as const], alias: "chia slot" },
  score: 0.05,
  open: `/api/projects/${MAP_PROJECT}/find/open?id=term%3A${RUN_SLOTS_ROW}`,
};

export const ISSUE_HIT = {
  ...RUN_SLOTS_HIT,
  id: "issue:i-1255",
  type: "issue" as const,
  ref: "i-1255",
  key: "ISS-1255",
  title: "The steward spends a fixed budget",
  status: "open",
  path: ["Execution", "Issues"] as [string, string],
  match: { arms: ["keyword" as const], alias: null },
  open: `/api/projects/${MAP_PROJECT}/find/open?id=issue%3Ai-1255`,
};

export const FIND_CHIA_SLOT: FindResult = {
  query: "chia slot",
  expanded: [{ term: "Run slots", alias: "chia slot", termId: RUN_SLOTS_ROW }],
  groups: [
    { type: "term", label: "Terms", hits: [RUN_SLOTS_HIT] },
    { type: "issue", label: "Issues", hits: [ISSUE_HIT] },
  ],
  facets: {
    type: [
      { value: "term", label: "Terms", count: 1 },
      { value: "issue", label: "Issues", count: 1 },
    ],
    module: [{ value: "execution", label: "Execution", count: 2 }],
    status: [
      { value: "active", label: "active", count: 1 },
      { value: "open", label: "open", count: 1 },
    ],
  },
  total: 2,
  degraded: false,
  gap: false,
};

export const FIND_NOTHING: FindResult = { query: "blorp", expanded: [], groups: [], facets: { type: [], module: [], status: [] }, total: 0, degraded: false, gap: true };
