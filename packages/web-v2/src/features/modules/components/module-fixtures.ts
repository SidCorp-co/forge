import type { ModuleDetail, ModuleRollupRow, ModuleStanding } from "../types";

export const standing = (over: Partial<ModuleStanding> = {}): ModuleStanding => ({
  attentionGroup: "quiet",
  open: 0,
  openByKind: { needs_you: 0, moving: 0, stuck: 0, queued: 0, paused: 0 },
  running: 0,
  waitingOn: { kind: "none", who: "Nobody", act: "nothing open", rule: "No issue waits", ref: null, issueKey: null },
  lastLanding: null,
  requirements: [],
  childCount: 0,
  ...over,
});

const counts = { total: 0, open: 0, closed: 0, recentlyActive: 0 };

export const rollupRow = (slug: string, over: Partial<ModuleRollupRow> = {}): ModuleRollupRow => ({
  id: `id-${slug}`,
  name: slug.toUpperCase(),
  slug,
  path: slug,
  description: null,
  knowledgeEntryId: null,
  color: "#000000",
  parentId: null,
  depth: 0,
  own: { primary: counts, secondary: counts },
  inherited: { primary: counts, secondary: counts },
  rollup: { primary: counts, secondary: counts },
  standing: standing(),
  ...over,
});

export const needsYou = standing({
  attentionGroup: "needs_you",
  open: 3,
  openByKind: { needs_you: 1, moving: 1, stuck: 0, queued: 1, paused: 0 },
  running: 1,
  waitingOn: { kind: "you", who: "You", act: "make a decision", rule: "parked at needs_info", ref: null, issueKey: "ISS-5" },
  lastLanding: {
    issueKey: "ISS-2",
    title: "Landed",
    landedAt: "2026-10-02T00:00:00.000Z",
    commitSha: "abcdef1234",
    target: "dev",
    landing: null,
    release: "1.4.0",
    modulePath: "outreach",
  },
});

export const detail = (over: Partial<ModuleDetail> = {}): ModuleDetail => ({
  module: { id: "id-outreach", slug: "outreach", name: "Outreach", path: "outreach", color: "#000000", description: null, parent: null, children: [] },
  standing: needsYou,
  purpose: { available: false, reason: "no knowledge entry is linked to this module" },
  keyPaths: { available: false, reason: "no knowledge entry is linked to this module" },
  couplings: { declared: [], observed: [] },
  landings: { total: 0, recent: [] },
  activity: { days: Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(21 + i).padStart(2, "0")}`, events: i === 13 ? 4 : 0 })), total: 4 },
  issues: [],
  feedback: [],
  contracts: { available: false, reason: "a contract names no module in its interface document" },
  owner: { available: false, reason: "a module label records no owner" },
  issuesRead: { returned: 3, open: 3 },
  ...over,
});
