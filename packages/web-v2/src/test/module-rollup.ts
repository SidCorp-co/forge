// A project's module rollup with four business modules, one moving, one stuck, one quiet, as core's
// `GET /projects/:id/modules/rollup` answers it: the Modules screen's test and its witness read it.

import type { ModuleRollupResponse } from "@forge/contracts/modules";
import type { QueryKey } from "@tanstack/react-query";
import { say } from "@forge/contracts/said";
import { waitingOn } from "@forge/contracts/standing";

export const MODULES_PROJECT = "7f1c1d1e-0000-4000-8000-000000001072";
const AT = "2026-11-06T09:00:00.000Z";
const counts = (open: number) => ({ total: open + 3, open, closed: 3, dropped: 0, recentlyActive: open });
const both = (open: number) => ({ primary: counts(open), secondary: counts(0) });
const dispatch = () => waitingOn("master", { who: say("standing.who.master"), act: say("issues.standing.act.dispatch"), rule: say("standing.act.none") });
const nobody = () => waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: say("standing.act.none") });

const moduleRow = (i: number, name: string, open: number, group: "moving" | "stuck" | "quiet") => ({
  id: `m${i}`,
  name,
  slug: `${name.toLowerCase().replace(/ /g, "-")}-${i}`,
  path: `${name.toLowerCase().replace(/ /g, "-")}-${i}`,
  description: null,
  knowledgeEntryId: null,
  color: "#336699",
  parentId: null,
  depth: 0,
  own: both(open),
  inherited: both(0),
  rollup: both(open),
  standing: {
    attentionGroup: group,
    waitingOn: group === "quiet" ? nobody() : dispatch(),
    leadIssue: open ? `ISS-${40 + i}` : null,
    open,
    openByKind: { moving: group === "moving" ? open : 0, stuck: group === "stuck" ? open : 0, queued: 0, paused: 0 },
    running: group === "moving" ? 1 : 0,
    lastLanding: i === 1 ? { issueKey: "ISS-41", title: "Rooms keep their thread", landedAt: AT, commitSha: null, target: "dev", landing: null, release: null, modulePath: "conversations-1" } : null,
    requirements: [],
    childCount: i % 2,
  },
});

export const MODULE_ROLLUP = {
  activeWithinDays: 14,
  generatedAt: AT,
  modules: [moduleRow(1, "Conversations", 3, "moving"), moduleRow(2, "Identity access", 1, "stuck"), moduleRow(3, "Releases", 2, "moving"), moduleRow(4, "Billing", 0, "quiet")],
  couplings: [{ parentId: null, aId: "m1", bId: "m2", sharedIssues: 2, weight: 2 }],
  unassigned: counts(9),
  issuesRead: { returned: 15, open: 15 },
} as unknown as ModuleRollupResponse;

export const MODULE_QUERIES: [QueryKey, unknown][] = [
  [["issues", "standing", "modules", MODULES_PROJECT, "rollup"], MODULE_ROLLUP],
  [["code-trace", MODULES_PROJECT], { units: [], untraced: 0, total: 0 }],
];
