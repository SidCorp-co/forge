// The reads of the screens ISS-1137 brought under the word budget (witness/screens.pages-rest.tsx),
// answered the way core answers them: a path pattern and its body, joined to the project home's reads
// by witness/screens.fixture.tsx. Each screen is drawn at a realistic fill: a list with several rows,
// a record with its facts, so its first view is counted as a person meets it, never as an empty state.

import type { ChannelView } from "@forge/contracts/support-channel";
import type { ModuleDetail } from "@forge/contracts/modules";
import { MODULE_ROLLUP } from "@/test/module-rollup";
import { APPROVALS_READ } from "@/test/approvals-read";
import { read as activityRead, FORGE, ADMINHUB, AHAPI, CATALOG, SILENT, QUIET, RECENT, LEDGER_NONE, ORG } from "@/test/activity.fixture";
import { previewOf, ticketBody } from "@/test/previews";
import { say } from "@forge/contracts/said";
import { waitingOn } from "@forge/contracts/standing";
import type { ApiPage, DocumentType, DocumentView, HeldEcosystem, ProjectEcosystemsResponse } from "@/features/ecosystem/types";
import { EPOD_CATALOG } from "./ecosystem-page.fixture";

const AT = "2026-10-21T09:00:00.000Z";
const EARLIER = "2026-10-14T09:00:00.000Z";
export const PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
export const ROOM_ID = "9a1b2c3d-0000-4000-8000-00000000a001";
export const SHARE_TOKEN = `forge_share_${"x".repeat(43)}`;
export const WIDGET_SITE = `fw_site_${"k".repeat(32)}`;
export const WIDGET_STATUS = `fw_stat_${"z".repeat(43)}`;
const ME = { userId: "7b1d2c3e-0000-4000-8000-000000000001", name: "Lan" };

// ── the workspace's own reads: the signed-in person, their org and its preferences ──
const SIGNED_IN = { id: ME.userId, email: "lan@hop.example", name: "Lan", hasPassword: true, oauthProviders: [] };
const ORGS = [{ id: ORG, slug: "hop", name: "Hop", isPersonal: false, role: "owner", createdAt: EARLIER }];
const PREFS = { theme: "system", language: null, notifyOnMention: true, activeOrgId: ORG, updatedAt: null };

// ── the project's modules: the home's three, each a whole rollup row; Patients a leaf with its detail ──
const ROLLUP = {
  ...MODULE_ROLLUP,
  modules: MODULE_ROLLUP.modules.slice(0, 3).map((m, i) => {
    const name = ["Patients", "Bookings", "Billing"][i] as string;
    return { ...m, name, slug: name.toLowerCase(), path: name.toLowerCase(), standing: { ...m.standing, childCount: 0 } };
  }),
  couplings: [],
};
const PATIENTS = ROLLUP.modules[0] as (typeof ROLLUP.modules)[number];
const MODULE_DETAIL: ModuleDetail = {
  module: { id: PATIENTS.id, slug: "patients", name: "Patients", path: "patients", color: PATIENTS.color, description: "Patient records and merges.", parent: null, children: [] },
  standing: PATIENTS.standing,
  purpose: { available: true, value: { entrySlug: "patients", title: "Patients", summary: "Who a patient is, and one record per person.", body: "", bodyTruncated: false, updatedAt: EARLIER } },
  keyPaths: { available: true, value: ["packages/core/src/patients"] },
  couplings: [{ module: { id: "m2", slug: "bookings", name: "Bookings", path: "bookings" }, issueCount: 2, recentIssueKeys: ["ISS-42"] }],
  landings: { total: 4, recent: [{ issueKey: "ISS-41", title: "Merge keeps the older record", landedAt: EARLIER, commitSha: null, target: "dev", landing: null, release: null, modulePath: "patients" }] },
  activity: { days: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.parse(AT) - (13 - i) * 86_400_000).toISOString().slice(0, 10), events: (i * 3) % 5 })), total: 28 },
  issues: [],
  feedback: [{ key: "FB-9", title: "Duplicate patients after import", phase: "planned" }],
  contracts: { available: false, reason: "No contract names this module." },
  owner: { available: false, reason: "No owner is recorded." },
  issuesRead: { returned: 6, open: 3 },
} as ModuleDetail;

// ── a bound channel and its record ──
const CHANNEL: ChannelView = {
  rid: "c1",
  name: "clinic-support",
  members: 3,
  rules: 1,
  commonIssues: 2,
  agent: null,
  memberRows: [
    { username: "thanh", roles: ["technical", "product"], state: "confirmed", askFor: "deploys", confirmedBy: "Lan", updatedAt: EARLIER },
    { username: "tram", roles: ["user"], state: "inferred", askFor: null, confirmedBy: null, updatedAt: EARLIER },
    { username: "minh", roles: ["user"], state: "inferred", askFor: null, confirmedBy: null, updatedAt: EARLIER },
  ],
  ruleRows: [{ id: "r1", text: "Answer patients in plain Vietnamese.", author: "lan", message: "m1", thread: "t1", createdAt: EARLIER }],
  commonIssueRows: [
    { id: "i1", question: "How do I move a booking?", answer: "Open it, then Move.", threads: 4, feedbackKey: null, updatedAt: EARLIER },
    { id: "i2", question: "Why is my invoice empty?", answer: "It fills after the visit.", threads: 2, feedbackKey: "FB-12", updatedAt: EARLIER },
  ],
  routes: [
    { route: "forge", members: [] },
    { route: "technical", members: ["thanh"] },
    { route: "product", members: ["thanh"] },
  ],
} as ChannelView;

// ── the project's contracts: three it provides or consumes, one waiting on the reader ──
const version = (v: string, approval = "approved") => ({ version: v, recordedAt: EARLIER, classification: "additive", approval, decidedAt: approval === "approved" ? EARLIER : null, previous: null, changes: [], decisionReason: null });
const project = { id: PROJECT, slug: "hop", name: "Hop Clinic API" };
const contractRow = (slug: string, title: string, state: string, group: string, pending: boolean) => ({
  ref: `hop/${slug}`,
  slug,
  provider: project,
  direction: "provided",
  title,
  summary: title,
  kind: "openapi",
  lifecycle: "active",
  current: version("1.2.0"),
  pending: pending ? version("2.0.0", "proposed") : null,
  queued: [],
  ours: "1.2.0",
  window: null,
  noticeDays: 14,
  consumers: { total: 2, current: 2, behind: 0 },
  state,
  touchedAt: EARLIER,
  attentionGroup: group,
  waitingOn: pending
    ? waitingOn("you", { who: say("standing.who.you"), act: say("contracts.act.approveOrReturn", { v: "2.0.0" }), rule: say("standing.act.none") }, { ref: "2.0.0" })
    : waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: say("standing.act.none") }),
});
const CONTRACTS = {
  generatedAt: AT,
  project,
  declared: true,
  contracts: [contractRow("bookings", "Bookings", "proposed", "needs_you", true), contractRow("patients", "Patients", "current", "current", false), contractRow("invoices", "Invoices", "current", "current", false)],
};

// ── the ecosystem's channel: the project's membership, its API page and one document ──
const ECO = EPOD_CATALOG.ecosystem;
const ECOSYSTEMS: ProjectEcosystemsResponse = {
  memberships: [{ id: "ms1", document: { ecosystem: ECO.id, project: PROJECT, state: "active" }, ecosystem: { id: ECO.id, slug: ECO.slug, name: ECO.name, channel: "EC" } }],
  returned: 1,
};
const API_PAGE: ApiPage = {
  project,
  reader: { access: "project" },
  declared: true,
  ecosystems: [{ id: ECO.id, slug: ECO.slug, name: ECO.name, visibility: "all" }],
  publishes: [
    { contract: "hop/bookings", slug: "bookings", title: "Bookings", type: "openapi", artifact: "none", lifecycle: "active", ecosystems: [ECO.slug], versions: [{ version: "1.2.0", approval: "approved" }], consumers: [{ project: { id: "p-b", slug: "ban", name: "Ban" }, ecosystem: ECO.slug, builtAgainst: "1.2.0" }] },
    { contract: "hop/patients", slug: "patients", title: "Patients", type: "openapi", artifact: "none", lifecycle: "active", ecosystems: [ECO.slug], versions: [{ version: "1.0.0", approval: "approved" }], consumers: [] },
  ],
  consumes: [{ contract: "ban/payments", provider: { id: "p-b", slug: "ban", name: "Ban" }, ecosystem: ECO.slug, builtAgainst: "3.1.0" }],
  commitments: { versioning: "semver", deprecationNoticeDays: 30, responseDays: { "change-notice": 5, rfi: 3, "change-request": 10 }, setBy: { agency: "agent", at: EARLIER } },
};
const DOCUMENT: DocumentView = {
  id: "d1",
  document: {
    id: "d1",
    number: "EC-1",
    ecosystem: ECO.id,
    from: "hop",
    to: ["ban"],
    type: "rfi",
    subject: "Booking refunds",
    dueBy: "2026-10-24",
    state: "published",
    authoredBy: { kind: "person", id: ME.userId, via: "web" },
    publishedAt: EARLIER,
    body: { question: "Do refunds keep the booking's payment id?" },
  },
  events: [{ verb: "publish", from: "draft", to: "published", by: { kind: "person", id: ME.userId, via: "web" }, at: EARLIER }],
  side: "sender",
  thread: "EC-1",
  hold: null,
  standing: { open: true, overdue: false, owner: ["ban"], recipients: [{ project: "ban", status: "awaiting", answeredBy: null }] },
  gateQuestionId: null,
};
const HELD: HeldEcosystem = {
  id: ECO.id,
  revision: 3,
  document: {
    $schema: "https://forge.sidcorp.co/schemas/ecosystem-v1.json",
    version: 1,
    ecosystem: { id: ECO.id, slug: ECO.slug, name: ECO.name, purpose: "Orders between the storefront and its suppliers.", steward: "o1" },
    channel: { code: "EC", responseDays: { "change-notice": 5, rfi: 3, "change-request": 10 } },
    gate: { "change-notice": "publish", acknowledgement: "publish", rfi: "publish", "change-request": "approve", decision: "approve" },
    visibility: { members: "all" },
  },
};

/** The person's threads across their ecosystems (`GET /ecosystems/mine`), from their own project (`MINE`) or to it: two waiting on them, one on a counterparty, one overdue, one answered. */
const [OURS, THEIRS] = EPOD_CATALOG.projects.map((p) => p.id) as [string, string];
export const MINE = [OURS];
const row = (n: number, type: DocumentType, subject: string, ours: boolean, status: "awaiting" | "answered" | "overdue") => ({
  number: `EC-${n}`,
  type,
  subject,
  from: ours ? OURS : THEIRS,
  to: [ours ? THEIRS : OURS],
  inReplyTo: null,
  thread: `EC-${n}`,
  state: "published" as const,
  authoredBy: { kind: "person" as const, id: ME.userId, via: "web" as const },
  publishedAt: EARLIER,
  dueBy: "2026-10-24",
  recipients: [{ project: ours ? THEIRS : OURS, status, answeredBy: null }],
  open: status !== "answered",
  overdue: status === "overdue",
  owner: status === "answered" ? [] : [ours ? THEIRS : OURS],
  hold: null,
  ecosystem: ECO.id,
});
export const THREADS = [
  row(1, "rfi", "Booking refunds", true, "awaiting"),
  row(2, "change-notice", "Payments v3 drops the old status field", false, "awaiting"),
  row(3, "change-request", "Add a clinic id to payments", true, "overdue"),
  row(4, "rfi", "Invoice rounding", false, "awaiting"),
  row(5, "rfi", "Refund window", true, "answered"),
];

// ── a preview room on a requirement, two turns in ──
const turn = (seq: number, ask: string, reply: string) => ({
  id: `0b1c2d3e-0000-4000-8000-00000000000${seq}`,
  seq,
  by: ME,
  ask,
  askedAt: EARLIER,
  reply,
  shownAt: EARLIER,
  shownAfterMs: 42_000,
  commit: "a".repeat(40),
  files: ["src/bookings/list.tsx"],
  kind: "ask",
});
const ROOM = {
  id: ROOM_ID,
  projectId: PROJECT,
  about: { kind: "requirement", key: "REQ-4", title: "Referrals" },
  branch: "sketch/req-4-abcdef",
  state: "open",
  detail: null,
  data: "demo",
  createdBy: ME,
  createdAt: EARLIER,
  preview: previewOf({ projectId: PROJECT, issueId: null, subject: { kind: "idea", about: { kind: "requirement", key: "REQ-4" }, branch: "sketch/req-4-abcdef", room: ROOM_ID } }),
  members: [{ ...ME, joinedAt: EARLIER }],
  turns: [turn(1, "Show referrals by clinic", "Grouped the list by clinic."), turn(2, "Put the newest first", "Sorted newest first.")],
  items: [],
  settle: null,
  canWrite: true,
};

// ── the operator's console ──
const glance = (value: number) => ({ value, deltaPct: 4, spark: [3, 4, 4, 5, 6, 5, 7] });
const OVERVIEW = {
  counts: { users: 42, usersNew: 3, orgs: 7, projects: 19, activeWorkspaces: 11, devicesOnline: 5, devicesTotal: 8 },
  kpis: { openAlerts: 2, inFlightJobs: 4, spendWindowUsd: 81.2, spendBaselineUsd: 74.9 },
  glance: { leadTimeMinutes: glance(96), interventionsPerClosed: glance(0.4), costPerClosedUsd: glance(3.1), successRatePct: glance(88), signupsWindow: glance(3) },
};
const alert = (id: string, status: string) => ({ id, key: `key_${id}`, status, count: status === "ok" ? 0 : 1, detail: `detail ${id}`, since: status === "ok" ? null : EARLIER, entities: [], changedAt: EARLIER });
const ALERTS = [alert("A1", "ok"), alert("A2", "warn"), alert("A3", "ok"), alert("A4", "crit"), alert("A5", "ok"), alert("A6", "ok")];

// ── what a share link, a widget and its status link answer ──
const SHARE = {
  audience: "link",
  expiresAt: "2026-10-28T09:00:00.000Z",
  document: {
    templateId: "progress",
    version: 1,
    params: {},
    runs: [],
    blocks: [],
    narrative: { summary: "Referrals moved: two criteria proven this week.", risks: "", recommendations: "Prove the clinic filter next." },
  },
};

/** The rows Needs you lists as the person's that are no decision, as core counts them in `/me/attention`. */
const OWED = APPROVALS_READ.notDecisions.reduce((n, o) => n + o.count, 0);

export const REST_READS: [RegExp, () => unknown][] = [
  [/^\/auth\/me$/, () => SIGNED_IN],
  [/^\/auth\/me\/preferences$/, () => PREFS],
  [/^\/orgs$/, () => ORGS],
  [/^\/orgs\/[^/]+\/agents$/, () => ({ agents: [{ userId: "a1", handle: "hop-builder", displayName: "Hop builder", email: "builder@agents.hop", projects: [], createdAt: EARLIER, activeTokens: 1, canAct: true }] })],
  [/^\/me\/attention$/, () => ({
    needsYou: [{ projectSlug: "hop", projectName: "Hop Clinic API", total: APPROVALS_READ.total, decisions: APPROVALS_READ.decisions.slice(0, 3), owed: APPROVALS_READ.notDecisions }],
    mentions: [{ kind: "mention", title: "Lan mentioned you on ISS-12", link: "/projects/hop/issues/ISS-12", since: EARLIER, issueRef: "ISS-12", projectSlug: "hop", projectName: "Hop Clinic API" }],
    failedJobs: [{ kind: "failed_job", title: "Build run failed on ISS-14", link: "/projects/hop/issues/ISS-14", since: EARLIER, issueRef: "ISS-14", projectSlug: "hop", projectName: "Hop Clinic API" }],
    channelGates: [],
    statusReports: [],
    offlineRunners: [{ kind: "runner_offline", title: "build-box is offline", link: "/runners", since: EARLIER, deviceName: "build-box" }],
    counts: { decisions: APPROVALS_READ.total, owed: OWED, mentions: 1, failedJobs: 1, channelGates: 0, statusReports: 0, offlineRunners: 1 },
    waitingOnYou: APPROVALS_READ.total,
    needsYouNotSent: 0,
    total: APPROVALS_READ.total + OWED + 3,
  })],
  [/^\/orgs\/[^/]+\/activity$/, () => activityRead([FORGE, ADMINHUB, AHAPI, CATALOG, SILENT, QUIET])],
  [/^\/orgs\/[^/]+\/activity\/[^/]+\/recent$/, () => RECENT],
  [/^\/projects\/[^/]+\/debts$/, () => LEDGER_NONE],
  [/^\/projects\/[^/]+\/cleanup-reports$/, () => ({ reports: [] })],
  [/^\/projects\/health$/, () => [{ id: PROJECT, projectName: "Hop Clinic API", projectSlug: "hop", throughput: 12, totalActive: 9, statusDistribution: { open: 5, in_progress: 4 }, blockers: [], pendingEscalations: 0, avgCycleTimeDays: 2.4, liveRuns: 1, runnerCount: 2, spend24hUsd: 3.2 }]],
  [/^\/version$/, () => ({ version: "0.4.0-dev.600", sourceCommit: "a".repeat(40) })],
  [/^\/projects\/[^/]+\/modules\/rollup$/, () => ROLLUP],
  [/^\/projects\/[^/]+\/modules\/[^/]+\/detail$/, () => MODULE_DETAIL],
  [/^\/projects\/[^/]+\/code-trace$/, () => ({ units: [], untraced: 0, total: 0 })],
  [/^\/projects\/[^/]+\/support\/channels$/, () => ({ channels: [{ rid: "c1", name: "clinic-support", members: 3, rules: 1, commonIssues: 2 }, { rid: "c2", name: "billing-help", members: 2, rules: 0, commonIssues: 1 }] })],
  [/^\/projects\/[^/]+\/support\/channels\/[^/]+$/, () => ({ channel: CHANNEL })],
  [/^\/projects\/[^/]+\/contract-standing$/, () => CONTRACTS],
  [/^\/projects\/[^/]+\/ecosystems$/, () => ECOSYSTEMS],
  [/^\/projects\/[^/]+\/api-page$/, () => API_PAGE],
  [/^\/projects\/[^/]+\/channel\/documents\/[^/]+$/, () => DOCUMENT],
  [/^\/ecosystems\/[0-9a-f-]{36}$/, () => HELD],
  [/^\/rooms\/[^/]+(\/join)?$/, () => ({ room: ROOM })],
  [/^\/previews\/[^/]+\/ticket$/, () => ticketBody("t1")],
  [/^\/projects\/[^/]+\/members$/, () => [{ userId: ME.userId, email: "lan@hop.example", name: "Lan", role: "admin", joinedAt: EARLIER }]],
  [/^\/projects\/[^/]+\/channel\/threads\/[^/]+$/, () => ({ thread: "EC-1", documents: [{ id: DOCUMENT.id, document: DOCUMENT.document, events: DOCUMENT.events, side: DOCUMENT.side }], holds: [] })],
  [/^\/invitations\/[^/]+$/, () => ({ projectName: "Hop Clinic API", inviterEmail: "lan@hop.example", role: "member", email: "lan@hop.example", expiresAt: "2026-10-28T09:00:00.000Z" })],
  [/^\/projects\/[^/]+\/speaker-links\/proposals$/, () => ({ speaker: { source: "rocketchat", namespace: "chat.hop.example", externalId: "u-77", username: "lan", emailOnChannel: "lan@hop.example" }, candidates: [], youMayConfirm: true })],
  [/^\/mcp-auth\/authorize$/, () => ({ client: { id: "c1", name: "Claude Code", redirectHost: "127.0.0.1:43123", registeredAt: EARLIER }, requestedScopes: ["read", "write"], menu: { permissions: ["issues:read", "issues:write", "account:read"], accountOnly: ["account:read"], explicit: [], full: "*" } })],
  [/^\/shares\/open(\/member)?$/, () => SHARE],
  [/^\/admin\/whoami$/, () => ({ isAdmin: true, email: "ops@forge.example" })],
  [/^\/admin\/overview$/, () => OVERVIEW],
  [/^\/admin\/alerts$/, () => ({ items: ALERTS, total: ALERTS.length })],
  [/^\/admin\/adoption$/, () => Array.from({ length: 8 }, (_, i) => ({ bucketStart: new Date(Date.parse(AT) - (7 - i) * 7 * 86_400_000).toISOString(), newUsers: i + 1, cumulativeUsers: 20 + i * 3, activeWorkspaces: 5 + i }))],
  [/^\/admin\/workspaces$/, () => ({ items: [{ projectId: PROJECT, slug: "hop", runs: 31, spendUsd: 22.4, medianLeadTimeMin: 84, openIssues: 9 }], total: 1 })],
  [/^\/widget\/fw_site_[^/]+\/config$/, () => ({ title: "Hop help", greeting: "Hi! Tell us what went wrong and we'll pass it on.", accent: "#0f766e", identity: { mode: "anonymous" }, messageMaxChars: 4000 })],
  [/^\/widget\/status\/[^/]+$/, () => ({ feedbackKey: "FB-31", title: "Pay button does nothing", phase: "in_progress", says: "We're fixing this now.", filedAt: EARLIER, updatedAt: AT })],
];
