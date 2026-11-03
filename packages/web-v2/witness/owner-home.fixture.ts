// The person's home as the witness and the screen budget draw it (ISS-919): what waits on them,
// what is moving for what they gave, what is live, and the org figures under its tab, each with the
// longest words it meets in the field.

import type { HomeFindResponse, HomeResponse } from "@forge/contracts/owner-home";
import type { PulseResponse } from "@forge/contracts/pulse";
import type { QueryKey } from "@tanstack/react-query";

export const AT = "2026-11-03T04:00:00.000Z";
export const ORG = "0b0e0f00-0000-4000-8000-000000000919";
const LONG = "A member's reply to the bot in a bound room thread is read for a correction, and the agent's lessons learn from it";

const decision = (n: number, group: string, entity: string, title: string) => ({
  id: `d${n}`,
  group,
  area: "development",
  entity,
  key: entity === "question" ? `q${n}` : `ISS-${n}`,
  title,
  opens: entity === "question" ? null : { kind: "issue", key: `ISS-${n}` },
  question: title,
  changes: "-",
  impact: "-",
  recommended: null,
  noRecommendation: "none",
  answers: [],
  touchedAt: AT,
  stuck: false,
  dueAt: null,
});

export const ATTENTION = {
  needsYou: [
    {
      projectSlug: "forge",
      projectName: "Forge",
      total: 4,
      decisions: [
        decision(1, "answer", "question", "Keep the old export format or move to the new one?"),
        decision(2, "approve", "issue", "Release 0.4.0 carries 12 issues"),
        decision(3, "verify", "issue", LONG),
      ],
    },
    { projectSlug: "adminhub-api", projectName: "Adminhub API", total: 1, decisions: [decision(4, "accept", "issue", "Invoices export to the new ledger")] },
  ],
  mentions: [],
  failedJobs: [],
  channelGates: [],
  statusReports: [],
  offlineRunners: [],
  counts: { mentions: 0, failedJobs: 0, channelGates: 0, statusReports: 0, offlineRunners: 0 },
  waitingOnYou: 5,
  total: 5,
};

const moving = (n: number, over: Partial<HomeResponse["moving"][number]>): HomeResponse["moving"][number] => ({
  kind: "issue",
  key: `ISS-${n}`,
  title: `Issue ${n}`,
  projectSlug: "forge",
  projectName: "Forge",
  stage: "planned",
  running: false,
  owes: { who: "Master", act: "dispatch it" },
  likelyBy: null,
  noDate: "no forecast: too little history",
  ...over,
});

export const HOME: HomeResponse = {
  generatedAt: AT,
  moving: [
    moving(919, { kind: "feedback", key: "FB-483", title: "The UI answers nothing I ask, so every status check is a question in chat", stage: "building", running: true, owes: { who: "Agent", act: "build" } }),
    moving(856, { title: LONG, stage: "landed", owes: { who: "Release", act: "ship it" }, likelyBy: "2026-11-04T10:00:00.000Z", noDate: null }),
    moving(862, { title: "A master post naming an undeclared room is refused by name", stage: "releasing", projectName: "Adminhub API", projectSlug: "adminhub-api" }),
    moving(870, { title: "Lessons carry their area", owes: null }),
    moving(871, { kind: "feedback", key: "FB-490", title: "The phone menu hides the release page", stage: "new", owes: { who: "Steward", act: "triage it" } }),
  ],
  live: [
    { projectSlug: "forge", projectName: "Forge", environment: "production", environmentName: "dev", version: "0.4.0-dev.457", name: "Live Build Checklist Clarity", at: AT, mine: 3 },
    { projectSlug: "adminhub-api", projectName: "Adminhub API", environment: "production", environmentName: "production", version: "2.14.0", name: "Ledger exports", at: "2026-11-02T09:00:00.000Z", mine: 1 },
    { projectSlug: "adminhub-api", projectName: "Adminhub API", environment: "testing", environmentName: "release/stg", version: "2.15.0-rc.1", name: null, at: "2026-11-03T01:00:00.000Z", mine: 0 },
  ],
};

export const FIND: HomeFindResponse = { q: "export", items: [] };

const project = (id: string, slug: string, name: string) => ({ id, slug, name, stuckRuns: 0, abandonedIssues: 1, lastIssueRunAt: AT, open: 14, inProgress: 3, awaitingRelease: 2, humanBlocked: 1 });
export const PULSE: PulseResponse = {
  generatedAt: AT,
  thresholds: { abandonedIssueSeconds: 86400, releaseWaitingSeconds: 86400, projectSilenceSeconds: 259200, silenceWarnSeconds: 3600, silenceAlarmSeconds: 14400, identityCap: 5 },
  liveness: {
    jobsRunning: 2,
    jobsQueued: 1,
    jobsHeld: 0,
    liveJobs: { total: 0, shown: [] },
    stuckRuns: { total: 0, shown: [] },
    lastJobAt: AT,
    silenceSeconds: 120,
    heartbeat: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(20 + i).padStart(2, "0")}`, issueRuns: (i * 7) % 11 })),
    devices: { online: 2, draining: 0, total: 3 },
  },
  work: {
    buckets: { open: 28, inProgress: 6, awaitingRelease: 4, humanBlocked: 2 },
    abandoned: { total: 0, shown: [] },
    releaseWaiting: { total: 0, shown: [] },
    notOnLive: { total: 0, shown: [] },
    liveUnmeasured: { total: 0, shown: [] },
    silentProjects: { total: 0, shown: [] },
    neverRanProjects: { total: 0, shown: [] },
    humanBlockedAges: [3600, 90000],
    perProject: [project("p1", "forge", "Forge"), project("p2", "adminhub-api", "Adminhub API")],
  },
  flow: Array.from({ length: 8 }, (_, i) => ({ weekStart: `2026-09-${String(7 + i * 3).padStart(2, "0")}`, created: 20 + i, closed: 18 + i, reopened: i % 3, backlog: 30 - i })),
  quality: {
    finished: { merged: 120, closedUnmerged: 4, dropped: 9 },
    reopened: { issues: 6, events: 8 },
    rework: { fix: 5, code: 3 },
    runFailure: { pipeline: { failed: 3, total: 80 }, other: { failed: 1, total: 20 } },
    sessionFailures: [],
    pipelineFlow: [],
  },
  actions: [],
};

/** The query cache a page with no active org reads the home from (witness/screens-all.witness.tsx). */
export const HOME_SEED: [QueryKey, unknown][] = [
  [["attention", null], ATTENTION],
  [["home", null], HOME],
];
