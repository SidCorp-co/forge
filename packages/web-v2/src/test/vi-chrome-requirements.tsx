import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { RequirementDetail, RequirementSummary } from "@/features/requirements/types";
import type { SuggestionView } from "@/features/suggestions/types";

// The Requirements screens' fixtures for the vi walking test: one requirement in delivery with every
// part of its page filled (a proposal open, criteria with evidence, issues, feedback, a design, a broken
// binding, a need, history of every kind), all its content carrying no English word of its own.

export const REQ_PROJECT = "p-vi";
const at = "2026-10-06T10:00:00Z";

const standing = {
  state: "agreed",
  attentionGroup: "needs_you",
  waitingOn: { kind: "you", who: "You", act: "accept r2", rule: "r", ref: null, dueAt: null, effect: undefined },
  delivery: { phase: "agreed", liveIssues: 2, startedIssues: 1, closedIssues: 1, criteriaCoverage: { criteria: 3, passing: 1, judged: 2 } },
  facts: {
    passing: 1,
    judged: 2,
    criteria: 3,
    issuesRunning: 1,
    issuesTotal: 2,
    proposedRevision: 2,
    draftRevision: null,
    stalePins: [],
    staleContractPins: [],
    unapprovedDesigns: [],
    feedbackOpen: 1,
    feedbackUntriaged: 0,
  },
  tasks: [],
  shownRevision: 2,
  coverage: [
    {
      code: "BC-1",
      body: "Tieu chi mot",
      verdict: "passing",
      issues: [{ issueId: "i1", displayId: "ISS-1", title: "Viec mot", status: "closed", tone: "done", criterion: 1, verdict: "pass", verdictAt: at, stale: false }],
    },
    {
      code: "BC-2",
      body: "Tieu chi hai",
      verdict: "failing",
      issues: [
        { issueId: "i2", displayId: "ISS-2", title: "Viec hai", status: "in_progress", tone: "run", criterion: 1, verdict: "fail", verdictAt: at, stale: true },
        { issueId: "i2", displayId: "ISS-2", title: "Viec hai", status: "in_progress", tone: "run", criterion: 2, verdict: null, verdictAt: null, stale: false },
      ],
    },
    { code: "BC-3", body: "Tieu chi ba", verdict: "gap", issues: [], uncoveredReason: "Ly do" },
  ],
  owner: { id: "u1", name: "Lan", kind: "human" },
  touchedAt: at,
} as unknown as RequirementSummary["standing"];

const criterion = (code: string, body: string, since: number) => ({ id: code, code, body, form: "statement" as const, sinceRevision: since, retiredRevision: null });

const revision = (n: number, state: string, over: Record<string, unknown> = {}) => ({
  revision: n,
  state,
  baseRevision: n > 1 ? n - 1 : null,
  spec: { goal: `Muc tieu ${n}`, personas: ["Ke toan"], scopeIn: [`Pham vi ${n}`], scopeOut: ["Ngoai le"], assumptions: [{ text: "Gia dinh mot", owner: "Lan", confirmBy: "Dem so lieu" }] },
  tldr: `Tom tat ${n}`,
  changeSummary: `Thay doi ${n}`,
  reason: `Ly do ${n}`,
  authorId: "u1",
  authorName: "Lan",
  authorKind: "human",
  createdAt: at,
  proposedAt: n === 2 ? at : null,
  decidedBy: null,
  decidedByName: null,
  decidedAt: n === 1 ? at : null,
  returnReason: null,
  acceptReason: null,
  fromSuggestionId: null,
  criteria: [criterion("BC-1", "Tieu chi mot", 1), criterion("BC-2", n === 2 ? "Tieu chi hai moi" : "Tieu chi hai", n), criterion("BC-3", "Tieu chi ba", 1)],
  ...over,
});

export const reqSummary = (key: string, over: Partial<RequirementSummary> = {}): RequirementSummary =>
  ({ id: `id-${key}`, key, title: `Muc ${key}`, status: "agreed", currentRevision: 1, latestRevision: { revision: 2, state: "proposed" }, delivery: standing.delivery, createdAt: at, updatedAt: at, standing, ...over }) as RequirementSummary;

export const reqDetail: RequirementDetail = {
  ...reqSummary("REQ-1"),
  revisions: [revision(2, "proposed"), revision(1, "current", { returnReason: "Chua ro" })],
  criteria: [criterion("BC-1", "Tieu chi mot", 1), criterion("BC-2", "Tieu chi hai moi", 2), criterion("BC-3", "Tieu chi ba", 1)],
  workflows: [
    { workflowId: "w1", flow: "thanh-toan", title: "Thanh toan", designStatus: "approved", approvedRevision: 3 },
    { workflowId: "w2", flow: "hoan-tien", title: "Hoan tien", designStatus: "proposed", approvedRevision: null },
  ],
  contracts: [],
  traces: [],
  baselines: [
    {
      revision: 1,
      seq: 1,
      act: "agree",
      agreedBy: "u1",
      agreedByName: "Lan",
      agreedAt: at,
      reason: null,
      readiness: null,
      pins: [{ kind: "contract-version", workflowId: null, flow: null, designRevision: null, providerProjectId: "p2", contractSlug: "kho/api", contractVersion: "1.2.0", mockupId: null }],
    },
  ],
  issues: [
    { issueId: "i1", displayId: "ISS-1", title: "Viec mot", status: "closed", tone: "done", plannedRevision: 1, changedSincePlan: false, shippedIn: { version: "0.1.0", at: "2026-10-01T00:00:00.000Z" } },
    { issueId: "i2", displayId: "ISS-2", title: "Viec hai", status: "in_progress", tone: "run", plannedRevision: 1, changedSincePlan: true, shippedIn: null },
  ],
  releases: [{ version: "0.1.0", at: "2026-10-01T00:00:00.000Z" }],
  canSignOff: true,
  history: [
    { id: "h1", at, source: "person", who: "Lan", kind: "Revision", text: "Proposed r2", issue: null, move: null },
    { id: "h2", at, source: "person", who: "Lan", kind: "Revision", text: "Wrote r2: Thay doi 2", issue: null, move: null },
    { id: "h3", at, source: "person", who: "Lan", kind: "Decision", text: "Accepted r1: Dong y", issue: null, move: null },
    { id: "h4", at, source: "person", who: "Lan", kind: "Returned", text: "Returned r1: Chua ro", issue: null, move: null },
    { id: "h5", at, source: "person", who: "Lan", kind: "Agreed", text: "Agreed r1", issue: null, move: null },
    { id: "h6", at, source: "agent", who: "BA assistant", kind: "Suggestion", text: "Suggested a revision", issue: null, move: null },
    { id: "h7", at, source: "person", who: "Lan", kind: "Decision", text: "Rejected a breakdown: Qua lon", issue: null, move: null },
    { id: "h8", at, source: "person", who: "Lan", kind: "Decision", text: "Deferred out of the current release (for Q4): Cho", issue: null, move: null },
    { id: "h9", at, source: "person", who: "Lan", kind: "Decision", text: "Undeferred", issue: null, move: null },
    { id: "h10", at, source: "person", who: "Lan", kind: "Decision", text: "Accepted the delivery: Tot", issue: null, move: null },
    { id: "h11", at, source: "person", who: "Lan", kind: "Decision", text: "Dropped: Bo", issue: null, move: null },
    { id: "h12", at, source: "person", who: "Lan", kind: "Agreed", text: "Re-pinned r1 onto the approved designs", issue: null, move: null },
    { id: "h13", at, source: "agent", who: "An agent", kind: "Question", text: "Hoi gi", issue: "ISS-2", move: null },
    { id: "h14", at, source: "person", who: "Someone", kind: "Answer", text: "Tra loi", issue: "ISS-2", move: null },
    { id: "h15", at, source: "system", who: "Forge", kind: "Status", text: "", issue: "ISS-2", move: { from: "open", to: "in_progress" } },
  ],
  readiness: null,
  dedup: null,
  deferral: null,
  feedback: [
    { id: "f1", key: "FB-1", title: "Phan hoi mot", kind: "bug", severity: "low", phase: "planned", open: true, via: { type: "issue", key: "ISS-2" }, route: { route: "issue", carriers: [{ key: "ISS-2" }], answer: null } },
    { id: "f2", key: "FB-2", title: "Phan hoi hai", kind: "idea", severity: "low", phase: "verified", open: false, via: { type: "workflow", key: "thanh-toan" }, route: null },
    { id: "f3", key: "FB-3", title: "Phan hoi ba", kind: "idea", severity: "low", phase: "verified", open: false, via: { type: "release", key: "0.1.0" }, route: null },
  ],
  request: { projectId: "p2", project: "Kho", contract: "kho/api" },
  questions: [
    { id: "q1", prompt: "Cau hoi mot", status: "open", place: { kind: "requirement" }, whoAnswers: "Chu phong kham", blocking: true, round: 1, askedAt: at, answer: null },
    { id: "q2", prompt: "Cau hoi hai", status: "open", place: { kind: "issue", key: "ISS-2", title: "Viec hai" }, whoAnswers: null, blocking: false, round: 1, askedAt: at, answer: null },
    { id: "q3", prompt: "Cau hoi ba", status: "answered", place: { kind: "run" }, whoAnswers: null, blocking: false, round: 1, askedAt: at, answer: { text: "Tra loi ba", at, by: "Lan" } },
  ],
  unclear: 2,
  bindings: [
    {
      workflowId: "w1",
      flow: "thanh-toan",
      designRevision: 3,
      step: "Buoc mot",
      contract: "kho/api",
      element: "GET /kho",
      contractType: "openapi",
      pinnedVersion: "1.2.0",
      brokenBy: "2.0.0",
      buildingIssues: [{ issueId: "i2", displayId: "ISS-2", title: "Viec hai", status: "in_progress" }],
    },
  ],
} as unknown as RequirementDetail;

const suggestion = (id: string, kind: SuggestionView["kind"], payload: unknown): SuggestionView =>
  ({
    id,
    kind,
    status: "proposed",
    target: { type: "requirement", id: "id-REQ-1" },
    baseRevision: 1,
    payload,
    payloadVersion: 1,
    fingerprint: id,
    revises: null,
    producerKind: "ba_assistant",
    producerId: null,
    conversationMessageId: null,
    model: null,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    createdAt: at,
    payloadPurgedAt: null,
  }) as SuggestionView;

export const reqSuggestions: SuggestionView[] = [
  suggestion("s1", "revision_diff", { changeSummary: "Doi ten", criteria: [{ code: "BC-1", body: "Moi" }] }),
  suggestion("s2", "readiness", { checks: [{ check: "Ro rang", passed: true }, { check: "Do duoc", passed: false, detail: "Thieu so" }] }),
  {
    ...suggestion("s3", "breakdown", { issues: [{}] }),
    breakdown: {
      unreadable: null,
      slices: [
        { title: "Lat mot", complexity: "s", description: null, criteria: [{ code: "BC-1", body: "Moi" }], builds: null, buildsRefusal: null, blockedBy: [] },
        { title: "Lat hai", complexity: "m", description: "Mo ta", criteria: [], builds: { flow: "thanh-toan", designRevision: 3 }, buildsRefusal: null, blockedBy: [{ slice: 0, title: "Lat mot" }, { issue: "ISS-2", title: "Viec hai", status: "open" }, { ref: "ISS-9", refusal: "KHONG", code: "X" }] },
      ],
      uncovered: [{ code: "BC-3", reason: "Chua co" }],
    },
  } as unknown as SuggestionView,
];

/** The screens' queries answered from the cache and never refetched; a query left out (the forecast) reaches no core and draws nothing. */
export function Seeded({ children, data }: { children: ReactNode; data: [QueryKey, unknown][] }) {
  const [client] = useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    for (const [key, value] of data) c.setQueryData(key, value);
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export const reqQueries = (): [QueryKey, unknown][] => [
  [["requirements", REQ_PROJECT], { requirements: [reqSummary("REQ-1"), reqSummary("REQ-2", { standing: { ...standing, attentionGroup: "done", state: "accepted" } as never })], returned: 2 }],
  [["requirement", REQ_PROJECT, "REQ-1"], reqDetail],
  [["suggestions", REQ_PROJECT, "*"], { suggestions: reqSuggestions }],
  [["suggestions", REQ_PROJECT, { requirement: "REQ-1" }], { suggestions: reqSuggestions }],
];
