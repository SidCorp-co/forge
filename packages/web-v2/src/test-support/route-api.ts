// A stand-in for the Forge API that answers every read a page makes in one of three states: every
// read failing, every read answering with nothing in it, or every read answering with something.
// The account, its organizations and its preferences always answer, so the shell around a page is
// the one a signed-in person sees. A read the table does not name is never guessed at: it fails,
// and the request is kept so a test can name the endpoint nobody answered.

import type { AdminAdoptionBucket, AdminOverview, ConnectionDirectoryItem, ConnectionListResponse, WorkspaceSshKeyView } from "@forge/contracts";
import type { PipelineRegistryResponse } from "@forge/contracts/pipeline-registry";
import type { WorkState } from "@forge/contracts/work-state";
import type { AgentAccountRow } from "@/features/agent-accounts/types";
import type { RunSessionsResponse } from "@/features/agents/types";
import type { AttentionResponse } from "@/features/attention/types";
import type { ConversationDetail, ListedRoom } from "@/features/conversations/types";
import type { Guide, GuideScope } from "@/features/guides/api";
import { PROVIDER_MODULES } from "@/features/integrations/providers/registry";
import type { IssueCostSummary, IssueDependencies, IssueDetail, IssueParkResponse, IssueRow } from "@/features/issues/types";
import type { KnowledgeEntry, ListKnowledgeResponse } from "@/features/knowledge/types";
import type { QuestionListResponse } from "@/features/questions/types";
import type { ReleaseRoster } from "@/features/releases/roster";
import type { OrgMemberRow, OrgProjectRow } from "@/features/orgs/types";
import type { PulseResponse } from "@/features/overview/types";
import type { SessionsAndHolds } from "@/features/pipeline/types";
import type { ProjectDetail, ProjectHealthRow, ProjectListItem } from "@/features/projects/types";
import type { ReleaseRunState } from "@/features/releases/types";
import type { StepDurationRow, ThroughputRow } from "@/features/runs/types";
import type { OrgDeviceRow } from "@/features/runners/types";
import type { ScheduleRow } from "@/features/schedules/types";
import type { TurnsResponse } from "@/features/session/types";
import type { QueueStats, SessionCost, SessionRow } from "@/features/sessions/types";
import type { AssistantPreferences, Preferences } from "@/features/settings/types";

export type ApiState = "failed" | "empty" | "loaded";

/** What one read answers: a body (status 200), or a status with a refusal. */
export type Answer =
  | { body: unknown }
  | { text: string }
  | { status: number; code?: string; message?: string }
  /** The read is still out: it never answers while the test reads the page. */
  | { held: true };

export type Read = (path: string, method: string) => Answer | undefined;

export const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
export const PROJECT_ID = "00000000-0000-4000-8000-0000000000b1";
export const SLUG = "atlas";
export const ISSUE_ID = "00000000-0000-4000-8000-0000000000c1";
export const SESSION_ID = "00000000-0000-4000-8000-0000000000d1";
export const RUN_ID = "00000000-0000-4000-8000-0000000000e1";
export const ROOM_ID = "00000000-0000-4000-8000-0000000000f1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const AT = "2026-10-20T08:00:00.000Z";

const ME = {
  id: USER_ID,
  email: "reader@example.org",
  emailVerified: true,
  displayName: "Reader",
  lastFreshAuthAt: AT,
  hasPassword: true,
  oauthProviders: [],
  createdAt: AT,
};

const ORG = { id: ORG_ID, name: "Northwind", slug: "northwind", role: "owner", isPersonal: false, createdAt: AT };

export const PROJECT: ProjectListItem = {
  id: PROJECT_ID,
  name: "Atlas",
  slug: SLUG,
  orgId: ORG_ID,
  orgName: "Northwind",
  orgIsPersonal: false,
  createdBy: USER_ID,
  role: "admin",
  orgRole: "owner",
  archivedAt: null,
  createdAt: AT,
};

/** The reads a signed-in shell makes whatever the state: who is reading, in which organizations. */
const ALWAYS: Record<string, unknown> = {
  "/auth/me": ME,
  "/orgs": [ORG],
  "/auth/me/preferences": {
    theme: "light",
    language: "en",
    notifyOnMention: true,
    lastSeenWhatsNew: null,
    activeOrgId: ORG_ID,
    updatedAt: AT,
  },
};

export interface ApiStub {
  /** Every read the pages made, as `METHOD path`. */
  readonly asked: Set<string>;
  /** Reads the state's table did not answer, which failed for it. */
  readonly unanswered: Set<string>;
  /** How many reads are held out, never answering. */
  held(): number;
  restore(): void;
}

function respond(answer: Exclude<Answer, { held: true }>): Response {
  if ("text" in answer) return new Response(answer.text, { status: 200, headers: { "content-type": "text/markdown" } });
  if ("body" in answer) {
    return new Response(JSON.stringify(answer.body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(
    JSON.stringify({ code: answer.code ?? "INTERNAL", message: answer.message ?? "The server ran into a problem." }),
    { status: answer.status, headers: { "content-type": "application/json" } },
  );
}

const FAILED = { status: 500, code: "INTERNAL", message: "The server ran into a problem and could not finish the request." };

/**
 * Puts a stand-in API on `fetch`. `reads` answers the state's reads (first match wins); `always`
 * answers whatever the state. A read neither answers fails with a 500 and is kept in `unanswered`.
 */
export function stubApi(state: ApiState, reads: Read[] = []): ApiStub {
  const asked = new Set<string>();
  const unanswered = new Set<string>();
  let held = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api(?=\/)/, "");
    const key = `${method} ${path}`;
    asked.add(key);
    if (method === "GET" && path in ALWAYS) return respond({ body: ALWAYS[path] });
    for (const read of reads) {
      const answer = read(path, method);
      if (answer && "held" in answer) {
        held += 1;
        return new Promise<Response>(() => {});
      }
      if (answer) return respond(answer);
    }
    if (state !== "failed") unanswered.add(key);
    return respond(FAILED);
  }) as typeof fetch;
  return {
    asked,
    unanswered,
    held: () => held,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * One read the pages make, and what it answers with nothing in it and with something in it. A read
 * with no `loaded` answer is one no page decides its state by (a badge, a side list, an entity the
 * page opens either way): it answers the same in both.
 */
interface Entry {
  /** A read other than GET names its method. */
  method?: string;
  match: RegExp;
  empty: Answer;
  loaded?: Answer;
}

const ok = (body: unknown): Answer => ({ body });
const none = { total: 0, shown: [] };

const PULSE = {
  generatedAt: AT,
  thresholds: {
    abandonedIssueSeconds: 3600,
    releaseWaitingSeconds: 86400,
    projectSilenceSeconds: 604800,
    silenceWarnSeconds: 86400,
    silenceAlarmSeconds: 259200,
    identityCap: 50,
  },
  liveness: {
    jobsRunning: 0,
    jobsQueued: 0,
    jobsHeld: 0,
    liveJobs: none,
    stuckRuns: none,
    lastJobAt: null,
    silenceSeconds: null,
    heartbeat: [],
    devices: { online: 0, draining: 0, total: 0 },
  },
  work: {
    buckets: { open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0 },
    abandoned: none,
    releaseWaiting: none,
    notOnLive: none,
    liveUnmeasured: none,
    silentProjects: none,
    neverRanProjects: none,
    blockedOnPersonAges: [],
    perProject: [],
  },
  flow: [],
  quality: {
    finished: { merged: 0, closedUnmerged: 0, dropped: 0 },
    reopened: { issues: 0, events: 0 },
    runFailure: { pipeline: { failed: 0, total: 0 }, scheduler: { failed: 0, total: 0 }, other: { failed: 0, total: 0 } },
    sessionFailures: [],
    pipelineFlow: [],
  },
} satisfies PulseResponse;

const WORK = { open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0, draft: 0, finished: 0 } satisfies Record<WorkState, number>;

const HEALTH = {
  id: PROJECT_ID,
  projectName: "Atlas",
  projectSlug: SLUG,
  description: null,
  repoPath: null,
  throughput: 2,
  totalActive: 1,
  work: { ...WORK, open: 1 },
  blockers: [],
  blockersTotal: 0,
  pendingEscalations: 0,
  avgCycleTimeDays: 1.5,
  liveRuns: 0,
  liveSessions: 0,
  runnerCount: 1,
  runnerTotal: 1,
  spend24hUsd: 1.25,
  memberCount: 1,
  members: ["R"],
  lastActivityAt: AT,
  stuckIssues: 0,
  stuckIssuesByKind: {},
  stuckIssueRefs: [],
} satisfies ProjectHealthRow;

const ISSUE = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  issSeq: 7,
  displayId: "ATL-7",
  title: "The export keeps its header",
  status: "open",
  priority: "medium",
  category: "bug",
  complexity: null,
  assigneeId: null,
  createdById: USER_ID,
  creatorEmail: null,
  creatorIsAgent: false,
  creatorLabel: "Reader",
  reopenCount: 0,
  mergedAt: null,
  statusEnteredAt: AT,
  createdAt: AT,
  updatedAt: AT,
} satisfies IssueRow;

const ISSUE_DETAIL = {
  ...ISSUE,
  description: "The export drops its header row.",
  plan: null,
  acceptanceCriteria: null,
  metadata: null,
} satisfies IssueDetail;

const SESSION = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  userId: USER_ID,
  deviceId: null,
  pipelineRunId: null,
  title: "Read the export",
  repoPath: null,
  status: "completed",
  usage: null,
  metadata: null,
  failureReason: null,
  dispatchedAt: AT,
  startedAt: AT,
  lastHeartbeatAt: AT,
  createdAt: AT,
  updatedAt: AT,
} satisfies SessionRow;

const RELEASE_STATE = {
  runId: RUN_ID,
  projectId: PROJECT_ID,
  runStatus: "running",
  roster: { gateStatus: "releasing", channels: [], releaseRunnerLabel: null, baseBranch: "main", nextCutAt: null, automaticRelease: false, issues: [], blockingAll: [] },
  runIssues: [],
  attempts: [],
  live: null,
  readings: { total: 0, latest: [] },
  verification: null,
  bounds: { holding: true, crossedNames: [], bounds: [] },
  method: null,
  methodUnloaded: false,
  start: { kind: "taken", at: AT, device: null },
} satisfies ReleaseRunState;

/** A room about Atlas the reader is one of the people of. */
export const ROOM = {
  id: ROOM_ID,
  adapter: "web",
  externalId: `web ${ROOM_ID}`,
  shape: "group",
  mode: null,
  title: "Export header",
  updatedAt: AT,
  archivedAt: null,
  messages: [],
  windows: [],
  agentTurns: [],
  agentMode: { available: true, reason: null, unbound: null },
  participants: [{ id: "pp1", kind: "person", userId: USER_ID, projectId: null, label: null, displayName: "Reader", reachable: true }],
  scope: [PROJECT_ID],
  scopeProjects: [{ id: PROJECT_ID, name: "Atlas", slug: SLUG }],
  canChangeMembership: true,
} satisfies ConversationDetail;

const GUIDE = {
  slug: "issue-dependencies",
  audience: "agent",
  title: "Issue dependencies",
  summary: "Only a blocks edge gates dispatch.",
  version: 1,
  body: "## Issue dependencies\n\nOnly a blocks edge gates dispatch.",
} satisfies Guide;

const GUIDE_SCOPE = {
  complete: false,
  listed: "The guides listed here.",
  elsewhere: "Other guides are served by the CLI.",
  reach: "Reach them with forge guide.",
  authority: "The code is right where a guide and it disagree.",
  cliServed: [],
} satisfies GuideScope;

const KNOWLEDGE = (rows: ListKnowledgeResponse["rows"]): ListKnowledgeResponse => ({
  rows,
  maxAlwaysInjectChars: 8000,
  alwaysInjectGuarantee: "Always-inject entries reach every prompt.",
  truncated: false,
  returned: rows.length,
  total: rows.length,
});

/** A provider this build knows, asked of the registry rather than named. */
const CONNECTED = PROVIDER_MODULES[0]?.provider;

const ADMIN_GLANCE = ["leadTimeMinutes", "interventionsPerClosed", "costPerClosedUsd", "successRatePct", "signupsWindow"] as const;

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  slug: SLUG,
  name: "Atlas",
  orgId: ORG_ID,
  createdBy: USER_ID,
  description: null,
  kind: "standard",
  repoPath: null,
  baseBranch: "main",
  releaseChain: [],
  repoUrl: null,
  workspaceSetup: null,
  defaultDeviceId: null,
  agentConfig: null,
  environments: null,
  issuePrefix: "ATL",
  archivedAt: null,
  createdAt: new Date(AT),
  members: [{ userId: USER_ID, role: "admin" }],
  labels: [],
  devicePool: [],
} satisfies ProjectDetail;

const ADMIN_OVERVIEW = {
  counts: { users: 0, usersNew: 0, orgs: 0, projects: 0, activeWorkspaces: 0, devicesOnline: 0, devicesTotal: 0 },
  kpis: { openAlerts: 0, inFlightJobs: 0, spendWindowUsd: 0, spendBaselineUsd: 0 },
  glance: Object.fromEntries(
    ADMIN_GLANCE.map((name) => [name, { value: null, deltaPct: null, spark: [] }]),
  ) as unknown as AdminOverview["glance"],
} satisfies AdminOverview;

/** Every read the app's pages make, by path. A path matched by none of these is never guessed at. */
export const ENTRIES: Entry[] = [
  { match: /^\/version$/, empty: ok({ version: "0.4.0", sourceCommit: null, uptimeSeconds: 600 }) },
  { match: /^\/notifications\/open-count$/, empty: ok({ count: 0 }) },
  { match: /^\/me\/devices$/, empty: ok([]) },
  {
    match: /^\/SidCorp-co\/forge\/main\/CHANGELOG\.md$/,
    empty: { text: "# Changelog\n" },
    loaded: { text: "# Changelog\n\n## [0.4.0] - 2026-10-20\n\n### Fixed\n\n- The export keeps its header.\n" },
  },
  { match: /^\/projects\/health$/, empty: ok([]), loaded: ok([HEALTH]) },
  {
    match: /^\/me\/attention$/,
    empty: ok({
      needsReview: [],
      awaitingInput: [],
      mentions: [],
      failedJobs: [],
      pendingSkillUpdates: [],
      unseenDrafts: [],
      unseenDraftsTotal: 0,
      bucketTotals: { needsReview: 0, awaitingInput: 0, mentions: 0, failedJobs: 0, pendingSkillUpdates: 0, unseenDrafts: 0 },
      projectTotals: {},
      total: 0,
    } satisfies AttentionResponse),
    loaded: ok({
      needsReview: [
        { kind: "needs_review", title: "The export keeps its header", link: `/projects/${SLUG}/issues/ATL-7`, since: AT, issueRef: "ATL-7", projectSlug: SLUG, projectName: "Atlas" },
      ],
      awaitingInput: [],
      mentions: [],
      failedJobs: [],
      pendingSkillUpdates: [],
      unseenDrafts: [],
      unseenDraftsTotal: 0,
      bucketTotals: { needsReview: 1, awaitingInput: 0, mentions: 0, failedJobs: 0, pendingSkillUpdates: 0, unseenDrafts: 0 },
      projectTotals: { [SLUG]: { needsReview: 1, awaitingInput: 0, awaitingAsked: 0, failedJobs: 0, parkedOnly: 0, parkedAsked: 0, stuckOnly: 0 } },
      total: 1,
    } satisfies AttentionResponse),
  },
  {
    match: /^\/me\/pulse$/,
    empty: ok(PULSE),
    loaded: ok({
      ...PULSE,
      work: {
        ...PULSE.work,
        buckets: { ...PULSE.work.buckets, open: 1 },
        perProject: [{ id: PROJECT_ID, slug: SLUG, name: "Atlas", open: 1, in_flight: 0, awaiting_release: 0, blocked_on_person: 0, stuckRuns: 0, abandonedIssues: 0, lastIssueRunAt: AT }],
      },
    } satisfies PulseResponse),
  },
  {
    method: "PATCH",
    match: /^\/auth\/me\/preferences$/,
    empty: ok({ theme: "light", language: "en", notifyOnMention: true, lastSeenWhatsNew: "0.4.0", activeOrgId: ORG_ID, updatedAt: AT } satisfies Preferences),
  },
  { match: /^\/auth\/oauth\/providers$/, empty: ok({ providers: [] }) },
  {
    match: /^\/auth\/preferences$/,
    empty: ok({
      theme: "light",
      language: "en",
      notifyOnMention: true,
      lastSeenWhatsNew: null,
      activeOrgId: ORG_ID,
      updatedAt: AT,
      answerStyle: "default",
      assistantInstructions: null,
    } satisfies Preferences & AssistantPreferences),
  },
  {
    match: /^\/integration-connections$/,
    empty: ok({ items: [] } satisfies ConnectionListResponse),
    loaded: ok({
      items: [
        {
          id: "00000000-0000-4000-8000-0000000000aa",
          ownerType: "org",
          ownerId: ORG_ID,
          provider: CONNECTED,
          displayName: "Northwind GitHub",
          config: {},
          active: true,
          lastHealthStatus: "ok",
          lastHealthAt: null,
          breakerOpenedAt: null,
          hasSecrets: true,
          createdAt: AT,
          updatedAt: AT,
          usage: { bindings: [] },
          access: { reach: "owner", canManage: true, ownerName: null },
        } as unknown as ConnectionDirectoryItem,
      ],
    } satisfies ConnectionListResponse),
  },
  {
    match: /^\/pipeline\/step-durations$/,
    empty: ok([]),
    loaded: ok([
      { runId: RUN_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, step: "code", startedAt: AT, finishedAt: AT, durationSeconds: 300, costUsd: 0.4 },
    ] satisfies StepDurationRow[]),
  },
  { match: /^\/pipeline\/throughput$/, empty: ok([]), loaded: ok([{ projectId: PROJECT_ID, date: "2026-10-20", count: 2 }] satisfies ThroughputRow[]) },
  { match: /^\/pipeline\/registry$/, empty: ok({ version: 1, runnerCapabilities: { "claude-code": ["drive"] } } satisfies PipelineRegistryResponse) },
  {
    match: /^\/orgs\/[^/]+\/members$/,
    empty: ok([]),
    loaded: ok([
      { userId: USER_ID, email: "reader@example.org", displayName: "Reader", kind: "person", projects: [{ id: PROJECT_ID, name: "Atlas" }], role: "owner", lenses: [], createdAt: AT },
    ] satisfies OrgMemberRow[]),
  },
  { match: /^\/orgs\/[^/]+\/projects$/, empty: ok([]), loaded: ok([{ id: PROJECT_ID, slug: SLUG, name: "Atlas", archivedAt: null, createdAt: AT }] satisfies OrgProjectRow[]) },
  { match: /^\/orgs\/[^/]+\/invitations$/, empty: ok([]) },
  {
    match: /^\/orgs\/[^/]+\/agents$/,
    empty: ok({ agents: [] }),
    loaded: ok({
      agents: [
        { userId: "00000000-0000-4000-8000-000000000002", handle: "builder", displayName: "Builder", email: "builder@agents.example.org", projects: [{ id: PROJECT_ID, role: "member" }], createdAt: AT, activeTokens: 1, canAct: true },
      ] satisfies AgentAccountRow[],
    }),
  },
  {
    match: /^\/orgs\/[^/]+\/ssh-keys$/,
    empty: ok([]),
    loaded: ok([
      {
        id: "00000000-0000-4000-8000-0000000000ab",
        orgId: ORG_ID,
        name: "deploy",
        note: null,
        source: "forge_generated",
        keyType: "ed25519",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample deploy",
        fingerprint: "SHA256:example",
        createdAt: AT,
        usedByProjects: [],
      },
    ] satisfies WorkspaceSshKeyView[]),
  },
  {
    match: /^\/orgs\/[^/]+\/devices$/,
    empty: ok([]),
    loaded: ok([
      {
        ownedByMe: true,
        id: "00000000-0000-4000-8000-0000000000ac",
        name: "build-box",
        platform: "linux",
        agentVersion: "0.4.0",
        agentCommit: null,
        latestAgentVersion: "0.4.0",
        latestAgentCommit: null,
        mainRunnerHead: null,
        agentBuildState: "current",
        runnerReleaseState: "current",
        agentBuildDetail: "This box runs the published release.",
        agentOutdated: false,
        status: "online",
        disabledAt: null,
        lastSeenAt: AT,
        pairedAt: AT,
        gitCredentialRef: null,
        createdAt: AT,
        runnerCount: 1,
        projectNames: ["Atlas"],
        heldBy: null,
        canRevoke: true,
      },
    ] satisfies OrgDeviceRow[]),
  },
  { match: /^\/orgs\/[^/]+\/rooms-without-a-project$/, empty: ok([]) },
  { match: /^\/agent-sessions$/, empty: ok({ items: [], total: 0 }) },
  {
    match: /^\/agent-sessions\/[^/]+\/cost$/,
    empty: ok({ sessionId: SESSION_ID, projectId: PROJECT_ID, estimatedCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0, sampleCount: 0, models: [] } satisfies SessionCost),
  },
  { match: /^\/agent-sessions\/queue-stats$/, empty: ok({ devices: [] } satisfies QueueStats) },
  { match: /^\/agent-sessions\/[^/]+$/, empty: ok(SESSION) },
  {
    match: /^\/agent-sessions\/[^/]+\/turns$/,
    empty: ok({ turns: [], nextCursor: null } satisfies TurnsResponse),
    loaded: ok({
      turns: [{ id: "t1", agentSessionId: SESSION_ID, turnIndex: 0, role: "user", content: { type: "user", message: { role: "user", content: "Read the export." } } as never, editedAt: null, createdAt: AT }],
      nextCursor: null,
    } satisfies TurnsResponse),
  },
  {
    match: /^\/conversations$/,
    empty: ok({ items: [], total: 0 }),
    loaded: ok({
      items: [
        { id: ROOM_ID, adapter: "web", externalId: ROOM_ID, shape: "group", mode: null, title: "Export header", updatedAt: AT, archivedAt: null, scope: [PROJECT_ID] },
      ] satisfies ListedRoom[],
      total: 1,
    }),
  },
  { match: /^\/conversations\/[0-9a-f-]{36}$/, empty: ok(ROOM) },
  { match: /^\/conversations\/openers$/, empty: ok({ openers: [] }) },
  { match: /^\/issues\/[^/]+$/, empty: ok(ISSUE_DETAIL) },
  { match: /^\/issues\/[^/]+\/activity$/, empty: ok({ items: [], nextBefore: null }) },
  { match: /^\/issues\/[^/]+\/attachments$/, empty: ok([]) },
  { match: /^\/issues\/[^/]+\/comments$/, empty: ok({ items: [], total: 0, nextCursor: null }) },
  {
    match: /^\/issues\/[^/]+\/cost-summary$/,
    empty: ok({ issueId: ISSUE_ID, projectId: PROJECT_ID, estimatedCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0, sampleCount: 0 } satisfies IssueCostSummary),
  },
  { match: /^\/issues\/[^/]+\/park$/, empty: ok({ park: null } satisfies IssueParkResponse) },
  { match: /^\/questions$/, empty: ok({ questions: [] } satisfies QuestionListResponse) },
  {
    match: /^\/projects\/[^/]+\/release-batches\/roster$/,
    empty: ok({ gateStatus: null, channels: [], releaseRunnerLabel: null, baseBranch: "main", nextCutAt: null, automaticRelease: false, issues: [], blockingAll: [] } satisfies ReleaseRoster),
  },
  { match: /^\/auth\/preferences\/changes$/, empty: ok({ items: [] }) },
  { match: /^\/issues\/[^/]+\/dependencies$/, empty: ok({ outgoing: [], incoming: [] } satisfies IssueDependencies) },
  { match: /^\/projects\/[^/]+$/, empty: ok(PROJECT_DETAIL) },
  {
    match: /^\/projects\/[^/]+\/issues\/search$/,
    empty: ok({ items: [], total: 0, buckets: { byStatus: {}, byWorkState: WORK } }),
    loaded: ok({ items: [ISSUE], total: 1, buckets: { byStatus: { open: 1 }, byWorkState: { ...WORK, open: 1 } } }),
  },
  {
    match: /^\/projects\/[^/]+\/knowledge$/,
    empty: ok(KNOWLEDGE([])),
    loaded: ok(KNOWLEDGE([{ id: "k1", slug: "build", kind: "fact", title: "Build commands", injection: "on_demand", confidence: "verified", authoredBy: "human", orderIndex: 0, updatedAt: AT }])),
  },
  {
    match: /^\/projects\/[^/]+\/knowledge\/[^/]+$/,
    empty: ok({ id: "k1", slug: "build", kind: "fact", title: "Build commands", injection: "on_demand", confidence: "verified", authoredBy: "human", orderIndex: 0, updatedAt: AT, body: "Run pnpm verify.", metadata: null, archivedAt: null, createdAt: AT } satisfies KnowledgeEntry),
  },
  { match: /^\/projects\/[^/]+\/(labels|members|runners)$/, empty: ok([]) },
  { match: /^\/projects\/[^/]+\/pipeline-runs$/, empty: ok({ items: [], total: 0 }) },
  { match: /^\/projects\/[^/]+\/release-batches\/[^/]+\/state$/, empty: ok(RELEASE_STATE) },
  {
    match: /^\/projects\/[^/]+\/run-sessions$/,
    empty: ok({ items: [], count: 0 } satisfies RunSessionsResponse),
    loaded: ok({
      items: [
        {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          masterSessionId: null,
          pid: null,
          worktreePath: "/work/atlas/.claude/worktrees/atl-7",
          bootId: "boot-1",
          incarnation: "live",
          work: "working",
          blockerKind: null,
          waitingOn: null,
          sessionTerminalAt: null,
          worktreeGoneAt: null,
          issues: [],
          deviceId: "00000000-0000-4000-8000-0000000000ac",
          deviceName: "build-box",
          observedAt: AT,
          sessionStatus: "running",
          sessionFailureReason: null,
          lastActivityAt: AT,
          masterTitle: null,
        },
      ],
      count: 1,
    } satisfies RunSessionsResponse),
  },
  {
    match: /^\/projects\/[^/]+\/sessions-and-holds$/,
    empty: ok({ sessions: [], holds: [], runningChats: [], readAt: AT } satisfies SessionsAndHolds),
    loaded: ok({
      sessions: [
        { id: SESSION_ID, kind: "pipeline", title: "Read the export", status: "running", runtimeState: null, deviceId: null, deviceName: "build-box", parentSessionId: null, startedAt: AT, lastHeartbeatAt: AT, createdAt: AT, issues: [], report: null },
      ],
      holds: [],
      runningChats: [],
      readAt: AT,
    } satisfies SessionsAndHolds),
  },
  { match: /^\/run-journal$/, empty: ok([]) },
  { match: /^\/runners\/active$/, empty: ok([]) },
  {
    match: /^\/schedules$/,
    empty: ok([]),
    loaded: ok([
      {
        id: "s1",
        projectId: PROJECT_ID,
        name: "Nightly sweep",
        cron: "0 3 * * *",
        prompt: "Sweep the backlog.",
        kind: "prompt",
        script: null,
        enabled: true,
        targetProjectSlug: null,
        lastRunAt: null,
        nextRunAt: AT,
        lastStatus: null,
        lastSessionId: null,
        metadata: null,
        templateKey: null,
        params: null,
        mode: null,
        appliedMessageVersions: null,
        createdAt: AT,
        updatedAt: AT,
      },
    ] satisfies ScheduleRow[]),
  },
  { match: /^\/(org-)?invitations\/[^/]+$/, empty: ok({ projectName: "Atlas", orgName: "Northwind", inviterEmail: "owner@example.org", role: "member", email: "reader@example.org", expiresAt: "2026-11-20T08:00:00.000Z" }) },
  {
    method: "POST",
    match: /^\/projects\/[^/]+\/speaker-links\/proposals$/,
    empty: ok({
      speaker: { source: "slack", namespace: "T1", externalId: "U1", username: "reader", emailOnChannel: null },
      candidates: [],
      youMayConfirm: true,
    }),
  },
  { match: /^\/guides$/, empty: ok({ guides: [], corpus: GUIDE_SCOPE }), loaded: ok({ guides: [GUIDE], corpus: GUIDE_SCOPE }) },
  { match: /^\/guides\/issue-dependencies$/, empty: ok({ guide: GUIDE }) },
  { match: /^\/admin\/overview$/, empty: ok(ADMIN_OVERVIEW) },
  { match: /^\/admin\/adoption$/, empty: ok([] satisfies AdminAdoptionBucket[]) },
  { match: /^\/admin\/workspaces$/, empty: ok({ items: [], total: 0 }) },
  { match: /^\/admin\/alerts$/, empty: ok({ items: [], total: 0 }) },
];

/** Where the reads are answered: `noProjects` answers the organization holding none, so a project's page has no project to open. */
export function readsFor(state: Exclude<ApiState, "failed">, { noProjects = false } = {}): Read[] {
  const project: Read = (path, method) =>
    method === "GET" && path === "/projects" ? { body: noProjects ? [] : [PROJECT] } : undefined;
  return [
    project,
    (path, method) => {
      const entry = ENTRIES.find((e) => (e.method ?? "GET") === method && e.match.test(path));
      if (!entry) return undefined;
      return state === "loaded" && entry.loaded ? entry.loaded : entry.empty;
    },
  ];
}

/** Every read failing but the project list, so a project's page reaches its own reads and sees them fail. */
export function projectOnly(): Read[] {
  return [(path, method) => (method === "GET" && path === "/projects" ? { body: [PROJECT] } : undefined)];
}

/** The read at `path` answers `answer` in place of the table's, whatever the state. */
export function answering(path: RegExp, answer: Answer): Read {
  return (p, method) => (method === "GET" && path.test(p) ? answer : undefined);
}
