// The workspace Activity read the web tests stand core in with (ISS-951, ISS-979): projects in each
// group, a lane with runs, a batch, two releases and two waits, and a Recent list.

import type { CleanupReportView, DebtLedgerView } from "@forge/contracts/cleanup";
import {
  ORG_ACTIVITY_GROUPS,
  type OrgActivity,
  type OrgActivityGroup,
  type OrgActivityLane,
  type OrgActivityMaster,
  type OrgActivityPerson,
  type OrgActivityProject,
  type OrgActivityRecent,
} from "@forge/contracts/org-activity";
import { fakeCore } from "./render";

export const ORG = "0d1b2c3d-0000-4000-8000-000000000001";
export const QUESTION_ID = "80ed3d9e-0c25-40e0-b984-6ae230a9c4d6";
export const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const LANE_FROM = ago(7200);
const LANE_EMPTY: OrgActivityLane = { from: LANE_FROM, runs: [], batches: [], releases: [], waits: [] };

export const master = (over: Partial<OrgActivityMaster> = {}): OrgActivityMaster => ({
  state: "idle",
  since: null,
  lastPassEndedAt: null,
  lastBeatAt: ago(20),
  silentAfterSeconds: 300,
  pane: null,
  doing: null,
  dialog: null,
  ...over,
});

export const person = (over: Partial<OrgActivityPerson> & Pick<OrgActivityPerson, "decisionId" | "title">): OrgActivityPerson => ({
  group: "answer",
  key: null,
  since: null,
  opens: null,
  ...over,
});

export const project = (over: Partial<OrgActivityProject> & Pick<OrgActivityProject, "projectId" | "slug" | "name" | "standing">): OrgActivityProject => {
  const people = over.people ?? { total: 0, items: [] };
  return {
    group: people.total > 0 ? "you" : over.standing,
    pause: null,
    master: master(),
    now: [],
    next: { total: 0, items: [], skip: null },
    people,
    peoplePending: false,
    release: null,
    releasePending: false,
    releasing: null,
    awaitingRelease: 0,
    lane: LANE_EMPTY,
    lastActivityAt: null,
    ...over,
  };
};

const PERSON_A = person({ decisionId: `question:${QUESTION_ID}`, key: "ISS-103", title: "Can the stg vhost be changed today, or only in the Friday window?", since: ago(1800) });
const PERSON_B = person({ decisionId: "approve:REQ-35", group: "approve", key: "REQ-35", title: "Accept revision r4", since: ago(1700) });
const PERSON_C = person({ decisionId: "answer:FB-147", key: "FB-147", title: "How should a product tour be drawn in a ux-flow design?", since: ago(300) });

export const FORGE = project({
  projectId: "p-forge",
  slug: "forge-slug",
  name: "Forge",
  standing: "working",
  master: master({
    state: "busy",
    lastBeatAt: ago(12),
    pane: { doing: "working", lastEventAt: ago(12), turnBeganAt: ago(40), writtenAt: null, seenAt: ago(12), source: "beat" },
    doing: { kind: "pass", verb: "dispatch", issueKey: "ISS-687", issueTitle: "No page asks a person to act on an issue" },
  }),
  now: [{ issueId: "i-948", key: "ISS-948", title: "The demo seed asks a steward decision", status: "in_progress", step: "build", stepSince: ago(17 * 60) }],
  next: { total: 43, items: [{ issueId: "i-935", key: "ISS-935", title: "The steward names the events door", priority: "medium" }], skip: null },
  people: { total: 43, items: [PERSON_A, PERSON_B, PERSON_C] },
  release: { key: "REQ-40", title: "Every release is a readable page", shipped: 7, awaitingRelease: 0, total: 8 },
  lane: {
    from: LANE_FROM,
    runs: [
      { from: ago(5400), to: ago(4200) },
      { from: ago(600), to: null },
    ],
    batches: [
      {
        at: ago(4500),
        moves: [
          { issueKey: "ISS-967", title: "Reopened issue held by its old release", from: "in_progress", to: "awaiting_release" },
          { issueKey: "ISS-968", title: "Sweep loops on a held head", from: "open", to: "in_progress" },
          { issueKey: "ISS-969", title: "Rooms read lists its threads", from: "open", to: "in_progress" },
        ],
      },
    ],
    releases: [
      { at: ago(3000), version: "0.4.0-dev.499", state: "released", total: 11, issues: [{ key: "ISS-967", title: "Reopened issue held by its old release" }] },
      { at: ago(600), version: "0.4.0-dev.503", state: "releasing", total: 1, issues: [{ key: "ISS-972", title: "Steward token minted twice" }] },
    ],
    waits: [
      { at: ago(1800), items: [PERSON_A, PERSON_B], more: 0 },
      { at: ago(300), items: [PERSON_C], more: 0 },
    ],
  },
  lastActivityAt: ago(180),
});
export const ADMINHUB = project({
  projectId: "p-ahfe",
  slug: "ahfe-slug",
  name: "AdminHub FE",
  standing: "idle",
  master: master({ state: "idle", lastBeatAt: ago(20), lastPassEndedAt: "2026-11-04T08:32:00.000Z", pane: { doing: "working", lastEventAt: ago(600), turnBeganAt: null, writtenAt: null, seenAt: ago(55), source: "pass" } }),
  next: { total: 2, items: [], skip: "one_at_a_time" },
  lastActivityAt: ago(3600),
});
export const AHAPI = project({
  projectId: "p-ahapi",
  slug: "ahapi-slug",
  name: "AdminHub API",
  standing: "paused",
  pause: "dialog",
  master: master({ state: "waiting_person", dialog: "Allow Bash: curl -sS https://staging.example ?", pane: { doing: "idle", lastEventAt: ago(80), turnBeganAt: null, writtenAt: null, seenAt: ago(80), source: "pass" } }),
});
export const CATALOG = project({
  projectId: "p-cat",
  slug: "catalog-slug",
  name: "Catalog API",
  standing: "none",
  master: master({ state: "none", lastBeatAt: null }),
  awaitingRelease: 44,
  release: { key: "REQ-4", title: "Two-way site sync", shipped: 7, awaitingRelease: 7, total: 15 },
  lane: { ...LANE_EMPTY, releases: [{ at: ago(2400), version: "2.4.1", state: "failed", total: 1, issues: [{ key: "ISS-41", title: "Price sync retries" }] }] },
});
export const SILENT = project({
  projectId: "p-orbit",
  slug: "orbit-slug",
  name: "Orbit",
  standing: "paused",
  pause: "silent",
  master: master({ state: "silent", lastBeatAt: ago(540) }),
});
export const QUIET = project({ projectId: "p-q", slug: "quiet-slug", name: "SidDesk", standing: "idle" });

export const read = (projects: OrgActivityProject[], refreshing = false): OrgActivity => ({
  generatedAt: new Date().toISOString(),
  orgId: ORG,
  projects,
  refreshing,
  totals: {
    projects: projects.length,
    ...(Object.fromEntries(ORG_ACTIVITY_GROUPS.map((g) => [g, projects.filter((p) => p.group === g).length])) as Record<OrgActivityGroup, number>),
  },
});

export const RECENT: OrgActivityRecent = {
  projectId: "p-forge",
  items: [
    { at: ago(60), kind: "run_started", issueKey: "ISS-688", issueTitle: "The ETA cell reads its paused reason" },
    { at: ago(300), kind: "pass_settled", issueKey: null, issueTitle: null, verb: "dispatch", dispatched: 1 },
    { at: ago(900), kind: "change_request", issueKey: "ISS-933", issueTitle: "A landing moves the step", ref: "!135" },
    { at: ago(1200), kind: "status", issueKey: "ISS-959", issueTitle: "Recent names each issue", to: "open" },
  ],
};

/** A project's debt ledger with no window on and nothing recorded: what a project never set up reads. */
export const LEDGER_NONE: DebtLedgerView = {
  fast: true,
  open: [],
  cleared: [],
  window: null,
  windowOff: "No cleanup window is on for this project, so no cleanup run starts here.",
};

/** Core over `fetch`: the workspace read, Forge's Recent list, and each project's cleanup (ISS-1051). */
export function serve(
  body: OrgActivity,
  cleanup: Record<string, { ledger: DebtLedgerView; reports: CleanupReportView[] }> = {},
) {
  return fakeCore((call) => {
    if (call.path === `/orgs/${ORG}/activity`) return { body };
    if (call.path === `/orgs/${ORG}/activity/p-forge/recent`) return { body: RECENT };
    // the live-run count every surface shares (ISS-1069): none live unless a test says so
    if (call.path === "/projects/health") return { body: [] };
    const at = /^\/projects\/([^/]+)\/(debts|cleanup-reports)$/.exec(call.path);
    if (at) {
      const c = cleanup[at[1] ?? ""] ?? { ledger: LEDGER_NONE, reports: [] };
      return { body: at[2] === "debts" ? c.ledger : { reports: c.reports } };
    }
    return undefined;
  });
}
