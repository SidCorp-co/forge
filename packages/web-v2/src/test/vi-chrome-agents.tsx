import type { Said } from "@forge/contracts/said";
import type { WaitingKind } from "@forge/contracts/standing";
import { RULE, say, verbatim, waitingOn } from "./said";
import type { MasterStanding } from "@forge/contracts/master-standing";
import type { RunStanding } from "@forge/contracts/run-standing";
import type { QueryKey } from "@tanstack/react-query";
import { AgentsScreen } from "@/features/agents/components/agents-screen";
import { MasterItemScreen, RunItemScreen } from "@/features/agents/components/agents-item-screens";
import { MasterPeek } from "@/features/agents/components/master-views";
import { RunPeek } from "@/features/agents/components/run-views";
import { QuestionsPane } from "@/features/agents/components/questions-pane";
import { DecisionPanel } from "@/features/questions/components/decision-panel";
import type { AgentQuestion } from "@/features/questions/types";
import { Seeded } from "./vi-chrome-requirements";

// The Agents / Runs screens of the Development space for the vi walking test: the runs list in each
// grouping, a run's peek and page in every state a run can stand in, the project master with its
// passes, leased runs and charter, and the questions a master asked. Names and titles are
// placeholder words; core's own rule, detail and failsBy sentences are the placeholder "r", and every
// sentence core says is built from its registry key, as core sends it.

const P = "p-agents";
const AT = "2026-10-07T08:00:00.000Z";
const NEAR = new Date(Date.now() + 5 * 60_000).toISOString();
const noop = () => {};
const access = { projectId: P, slug: "hop", canWrite: true };
const peek = { open: "x", position: { at: 1, of: 3 }, set: noop, move: noop };
const device = { id: "d1", name: "may-1" };
const RUN = say("issues.standing.who.run");
const none = { source: "none", detail: "r", says: { detail: RULE } } as const;

const wait = (kind: WaitingKind, who: Said, act: Said, at: { ref?: string; dueAt?: string } = {}) => waitingOn(kind, { who, act, rule: RULE }, at);
const held = { source: "held", kind: "run", name: "tho-1", sessionId: "s1", device, acquiredAt: AT, expiresAt: NEAR, expirySource: "claim", verdict: "live", expiryDetail: null, expiries: [{ source: "claim", at: NEAR, verdict: "live", rule: "r", says: { rule: RULE } }], dispatchedBy: { source: "pass", masterSessionId: "m1", passId: "pass-1", verb: "dispatch", startedAt: AT }, says: { name: say("standing.who.named", { name: "tho-1" }), expiryDetail: null } };

const run = (n: number, over: Record<string, unknown> = {}): RunStanding =>
  ({
    id: `run-${n}-0000-aaaa`,
    projectId: P,
    lane: "issue",
    state: "running",
    since: AT,
    rule: "r",
    title: `Viec ${n}`,
    says: { rule: RULE, title: verbatim(`Viec ${n}`) },
    issue: { key: `ISS-${n}`, title: `Viec ${n}`, status: "in_progress" },
    issues: [`ISS-${n}`],
    sessionId: `s-${n}`,
    step: { source: "work_state", step: "build", since: AT },
    attempt: { source: "runs", n: 2, retryOf: "run-0-0000-aaaa", of: "run-0-0000-aaaa" },
    lastBeatAt: AT,
    liveJobs: 1,
    device,
    holder: held,
    outcome: null,
    master: { source: "session", sessionId: "m1", name: "master-1", live: true },
    stuck: { source: "clear", detail: "r", says: { detail: RULE } },
    release: null,
    deployLocks: [],
    pipelineStatus: "running",
    job: { id: "j1", type: "code", status: "dispatched" },
    startedAt: AT,
    finishedAt: null,
    attentionGroup: "running",
    waitingOn: wait("run", RUN, say("issues.standing.act.stepFor", { step: "build", n: 12 }), { dueAt: NEAR }),
    ...over,
  }) as unknown as RunStanding;

const stuckRule = (rule: string) => ({ source: "stuck", rule, disagreement: null, since: AT, evidence: { table: "jobs", id: "j1", column: "last_heartbeat_at", value: AT, at: AT }, failsAt: NEAR, failsBy: "r", detail: "r", says: { failsBy: RULE, detail: RULE } });
const by = { type: "user", agency: "human", userId: "u1", name: "Lan", reason: "Trung", at: AT };

const RUNS: RunStanding[] = [
  run(1, { state: "waiting_person", attentionGroup: "needs_you", waitingOn: wait("you", say("standing.who.you"), say("issues.standing.act.answer"), { ref: "q1" }), holder: none }),
  run(2, { state: "stuck", attentionGroup: "stuck", stuck: stuckRule("lease_expired"), waitingOn: wait("run", RUN, say("issues.standing.act.stepFor", { step: "build", n: 3 }), { dueAt: NEAR }) }),
  run(3, { state: "waiting_gate", attentionGroup: "waiting_gate", waitingOn: { kind: "gate", gate: "retry_cooldown", resumesAt: NEAR, rule: "r", says: { rule: RULE } }, holder: none }),
  run(4, { state: "waiting_person", attentionGroup: "waiting", waitingOn: wait("person", say("standing.who.named", { name: "Lan" }), say("designs.act.approveOrReturn", { r: 2 })), holder: none }),
  run(5, { state: "queued", attentionGroup: "queued", waitingOn: wait("master", say("standing.who.master"), say("issues.standing.act.dispatch")), holder: none, device: null, lastBeatAt: null, attempt: none }),
  run(6, { lane: "release", state: "running", release: { version: "0.1.0", stage: "deploying", verdict: null, attemptAt: AT }, deployLocks: [{ environment: "production", subject: "0.1.0", acquiredAt: AT, expiresAt: NEAR, reclaimedFromRunId: null }], issue: null, issues: ["ISS-1", "ISS-2"] }),
  run(7, { state: "done", attentionGroup: "finished", outcome: { kind: "done", at: AT, by }, finishedAt: AT, waitingOn: wait("none", say("standing.who.nobody"), say("standing.act.none")), holder: none, liveJobs: 0 }),
  run(8, { state: "failed", attentionGroup: "finished", outcome: { kind: "failed", at: AT, cause: "agent_exited_without_result", classified: true, detail: "r" }, finishedAt: AT, waitingOn: wait("none", say("standing.who.nobody"), say("standing.act.none")), holder: none, liveJobs: 0 }),
  run(9, { state: "cancelled", attentionGroup: "finished", outcome: { kind: "cancelled", at: AT, by }, finishedAt: AT, waitingOn: wait("none", say("standing.who.nobody"), say("standing.act.none")), holder: none, liveJobs: 0 }),
  run(10, { state: "handed_back", attentionGroup: "finished", outcome: { kind: "handed_back", at: AT, close: "died", returnedTo: [{ issueKey: "ISS-10", status: "open" }], detail: "r", says: { detail: RULE } }, finishedAt: AT, waitingOn: wait("none", say("standing.who.nobody"), say("standing.act.none")), holder: none, liveJobs: 0 }),
  run(11, { lane: "job", state: "running", issue: null, issues: [], job: { id: "j2", type: "triage", status: "dispatched" }, step: { source: "none", step: null, detail: "r", says: { detail: RULE } } }),
  run(12, { lane: "deploy", state: "running", issue: null, issues: [], step: { source: "run_column", step: "build", since: null } }),
  run(13, { state: "stuck", attentionGroup: "stuck", stuck: { ...stuckRule("disagreement"), disagreement: "box-live-core-terminal" } }),
] as RunStanding[];

const MASTER = {
  generatedAt: AT,
  projectId: P,
  state: "in_pass",
  sessionId: "m1-session-0001",
  name: "master-1",
  device,
  since: AT,
  pass: { id: "pass-9", sessionId: "m1", verb: "dispatch", startedAt: AT, issueKey: "ISS-3", trigger: "nudge" },
  lastPass: { id: "pass-8", sessionId: "m1", verb: "judge", startedAt: AT, endedAt: AT, issueKey: null, trigger: "unprompted", dispatched: ["ISS-4"], skipped: [{ issueKey: "ISS-5", refusal: "r" }], parked: ["ISS-6"], refused: null, recovers: null, closeReason: "turn_ended" },
  slots: { inUse: 1, max: 3, runs: 1, undeclared: null },
  runsOut: 1,
  lastBeatAt: AT,
  silentAfterSeconds: 300,
  waitingOn: { kind: "person", who: "Lan", act: "answer a pane dialog", rule: "MASTER_PANE_DIALOG", since: AT, says: { who: say("standing.who.named", { name: "Lan" }), act: say("masters.act.answerDialog", { pane: say("masters.act.theMasterPane"), text: "Tiep tuc?" }) } },
  dialogsAnswered: { count: 4, countIsFloor: false, firstAt: AT, lastAt: AT, last: "Dong y", lastAgent: "master-1" },
  outdated: { since: AT, why: "r", heldBy: ["ISS-3"], draining: true },
} as unknown as MasterStanding;

const MASTERS_IDLE = { ...MASTER, state: "none", sessionId: null, name: null, device: null, pass: null, lastPass: null, slots: null, runsOut: 0, waitingOn: null, dialogsAnswered: null, outdated: null, lastBeatAt: null } as unknown as MasterStanding;

const list = (scope: "live" | "finished", items: RunStanding[], master: MasterStanding = MASTER) => ({
  generatedAt: AT,
  projectId: P,
  scope,
  scopeRule: "r",
  says: { scopeRule: RULE },
  items,
  total: items.length,
  limit: 200,
  offset: 0,
  hasMore: false,
  counts: { live: 8, finished: 4, liveByState: { queued: 1, claimed: 0, running: 3, waiting_person: 2, waiting_gate: 1, stuck: 2 }, needsViewer: 1, held: 5 },
  excluded: [{ what: "r", count: 2, rule: "r", says: { rule: RULE } }],
  master,
});

const detail = (r: RunStanding) => ({
  generatedAt: AT,
  run: r,
  attempts: [
    { id: "a1", n: 1, state: "failed", startedAt: AT, finishedAt: AT },
    { id: "a2", n: 2, state: r.state, startedAt: AT, finishedAt: null },
  ],
  events: [
    { id: "e1", at: AT, entity: "run", from: "paused", to: "running", reason: "r", actor: { type: "runner", agency: "agent", name: "may-1" }, source: "r" },
    { id: "e2", at: AT, entity: "job", from: null, to: "failed", reason: null, actor: { type: "user", agency: "human", name: "Lan" }, source: "r" },
  ],
  eventsHasMore: true,
});

const question = (id: string, over: Partial<AgentQuestion> = {}): AgentQuestion =>
  ({
    id,
    projectId: P,
    issueId: null,
    status: "open",
    blockerKind: "human",
    steps: [{ round: 1, prompt: "Chon luong nao truoc?", askedAt: AT, answerShape: "choice", options: [{ id: "o1", label: "Luong mot", authority: "writer", bindsTo: "this_call", executedBy: "agent" }, { id: "o2", label: "Luong hai", authority: "admin", bindsTo: "project", executedBy: "core" }], recommendedOptionId: "o1" }],
    maxRounds: 3,
    voidReason: null,
    endedReason: null,
    parkDeadlineAt: NEAR,
    createdAt: AT,
    updatedAt: AT,
    answerShape: "choice",
    options: [{ id: "o1", label: "Luong mot", authority: "writer", bindsTo: "this_call", executedBy: "agent", locked: false }, { id: "o2", label: "Luong hai", authority: "admin", bindsTo: "project", executedBy: "core", locked: true }],
    recommendedOptionId: "o1",
    needed: "luong dau tien",
    locked: false,
    ...over,
  }) as AgentQuestion;

const freeText = (id: string) =>
  question(id, { answerShape: "free_text", options: [], recommendedOptionId: "", steps: [{ round: 1, prompt: "Ghi ro luong nao?", askedAt: AT, answerShape: "free_text", needed: "luong dau tien" }] });
const answered = (id: string) =>
  question(id, { status: "answered", locked: false, steps: [{ round: 1, prompt: "Ghi ro?", askedAt: AT, answerShape: "free_text", needed: "x", answeredAt: AT, answerText: "luong mot", hold: { reason: "Cho thiet ke", blockedBy: { id: "i2", key: "ISS-12" } }, resume: { kind: "held", at: AT } } as never] });
const voided = (id: string) => question(id, { status: "void", voidReason: "r", endedReason: "park_unanswered", locked: false });

const data = (): [QueryKey, unknown][] => [
  [["runs-standing", P, "list", "live"], list("live", RUNS.filter((r) => r.attentionGroup !== "finished"))],
  [["runs-standing", P, "list", "finished"], list("finished", RUNS.filter((r) => r.attentionGroup === "finished"), MASTERS_IDLE)],
  [["runs-standing", P, "list", "all"], list("all" as never, RUNS)],
  ...RUNS.map((r) => [["runs-standing", P, "run", r.id], detail(r)] as [QueryKey, unknown]),
  [["runs-standing", P, "master"], MASTER],
  [["runs-standing", P, "passes"], { generatedAt: AT, projectId: P, items: [MASTER.pass, MASTER.lastPass, { ...(MASTER.lastPass as object), id: "pass-7", refused: { reason: "usage_limit", detail: "r" }, dispatched: [], skipped: [], parked: [], closeReason: "abandoned_quiet" }, { ...(MASTER.lastPass as object), id: "pass-6", recovers: { refusedSince: AT, refusedPasses: 2, reason: "usage_limit" }, closeReason: "session_gone" }], limit: 50, hasMore: true, next: "c" }],
  [["runs-standing", P, "charter"], { declared: true, version: 3, goal: "Muc tieu cua master", rules: ["Quy tac mot", "Quy tac hai"], declaredBy: "Lan", declaredAt: AT }],
  [["questions", "project", P], { pages: [{ questions: [question("q1"), freeText("q2"), answered("q3"), voided("q4")], total: 4, hasMore: false, nextCursor: null }], pageParams: [null] }],
  [["questions", "i1"], { questions: [{ ...freeText("q5"), issueId: "i1" }, { ...answered("q6"), issueId: "i1" }, { ...voided("q7"), issueId: "i1" }] }],
  [["project", P], { id: P, slug: "hop", name: "Hop", devicePool: [] }],
  [["agent-sessions", "list", { projectId: P, page: 1 }], { items: [], totalCount: 0 }],
];

const wrap = (children: React.ReactNode) => <Seeded data={data()}>{children}</Seeded>;
const withUrl = (qs: string, children: React.ReactNode) => {
  window.history.replaceState(null, "", `/${qs}`);
  return wrap(children);
};

export const SCREENS = [
  { name: "Agents · runs", render: () => withUrl("", <AgentsScreen access={access} />) },
  { name: "Agents · runs finished", render: () => withUrl("?scope=finished", <AgentsScreen access={access} />) },
  { name: "Agents · runs by box", render: () => withUrl("?group=box&scope=all", <AgentsScreen access={access} />) },
  { name: "Agents · runs by lane", render: () => withUrl("?group=lane&scope=all", <AgentsScreen access={access} />) },
  { name: "Agents · runs filtered", render: () => withUrl("?f=you,stuck&q=zzz", <AgentsScreen access={access} />) },
  { name: "Agents · questions", render: () => withUrl("?tab=questions", <AgentsScreen access={access} />) },
  { name: "Agents · questions pane", render: () => wrap(<QuestionsPane scope={access} />) },
  { name: "Agents · sessions tab", render: () => withUrl("?tab=sessions", <AgentsScreen access={access} />) },
  ...RUNS.filter((_, i) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12].includes(i)).map((r, i) => ({
    name: `Run peek · ${r.state} ${i}`,
    render: () => wrap(<RunPeek r={r} slug="hop" canWrite peek={peek} onOpenFull={noop} />),
  })),
  ...[0, 1, 5, 7, 9, 10, 12].map((i) => ({
    name: `Run page · ${(RUNS[i] as RunStanding).state} ${i}`,
    render: () => withUrl("", <RunItemScreen access={access} runId={(RUNS[i] as RunStanding).id} />),
  })),
  ...(["attempts", "events", "lease"] as const).map((tab) => ({
    name: `Run page · ${tab}`,
    render: () => withUrl(`?tab=${tab}`, <RunItemScreen access={access} runId={(RUNS[5] as RunStanding).id} />),
  })),
  { name: "Run page · lease with no holder", render: () => withUrl("?tab=lease", <RunItemScreen access={access} runId={(RUNS[6] as RunStanding).id} />) },
  { name: "Master page · passes", render: () => withUrl("", <MasterItemScreen access={access} />) },
  { name: "Master page · runs", render: () => withUrl("?tab=runs", <MasterItemScreen access={access} />) },
  { name: "Master page · charter", render: () => withUrl("?tab=charter", <MasterItemScreen access={access} />) },
  { name: "Master peek", render: () => wrap(<MasterPeek m={MASTER} peek={peek} onOpenFull={noop} />) },
  { name: "Master peek · none", render: () => wrap(<MasterPeek m={MASTERS_IDLE} peek={peek} onOpenFull={noop} />) },
  { name: "Issue decisions", render: () => wrap(<DecisionPanel issueId="i1" />) },
];
