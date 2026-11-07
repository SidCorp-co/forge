// The surfaces ISS-680 brings to the UI copy rule, drawn as a person reads them (FB-281): the issue
// page's Stuck banner over a real release hold; Needs you and the card
// of a park re-kinded to wait on a resource; the re-point notice core posts in the thread; and the
// Approvals peek of a question about a requirement its evidence also names. The probe answers each
// raw code, route, double stop or repeated requirement a person's view still shows.
//
//   pnpm --filter web-v2 witness witness/stuck-copy.witness.tsx --out <dir>

import type { IssueStanding } from "@forge/contracts/issue-standing";
import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import type { Said } from "@forge/contracts/said";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DecisionPeek } from "@/features/approvals/components/approval-peek";
import { CommentThread } from "@/features/issues/components/comment-thread";
import { IssueStateHead } from "@/features/issues/components/detail/issue-state-head";
import { IssueStuckBanner } from "@/features/issues/components/issue-standing-bits";
import type { CommentNode } from "@/features/issues/types";
import { IssueQuestions } from "@/features/questions";
import "./entry";
import { InRouter } from "./router";

const REASON =
  "The automatic release aborted its cut and could not put the issues back: the abort is blocked until a person clears it: " +
  "the open question answered, then cut the release by hand (POST /api/projects/p1/releases/cut) once every issue it carried is back at `awaiting_release`.";
const who: Said = { key: "standing.who.named", vars: { name: "Lan" } };
const rule: Said = { key: "issues.rule.releaseHeld", vars: { code: "RELEASE_ABORT_BLOCKED", reason: REASON } };
const stuck = {
  attentionGroup: "stuck",
  releaseHold: { code: "RELEASE_ABORT_BLOCKED", reason: REASON, owes: "human", waitingFor: "the open question answered", heldAt: "2026-10-24T00:00:00.000Z" },
  waitingOn: { kind: "person", who: "Lan", act: "", rule: "", ref: null, dueAt: null, says: { who, act: { key: "issues.releaseHold.act.releaseAbortBlocked" }, rule } },
  times: {
    actClass: "person_act",
    since: "2026-10-24T00:00:00.000Z",
    dueAt: null,
    stuck: { code: "blocked", since: "2026-10-24T00:00:00.000Z", reason: "", via: null, says: { reason: { key: "standing.stuck.blocked", vars: { who, rule } } } },
    carriedBy: null,
    basis: "b1",
  },
} as unknown as IssueStanding;

const NEEDED = "a staging database URL";
const parked = {
  attentionGroup: "queued",
  state: "needs_info",
  step: null,
  stepStartedAt: null,
  tone: "ready",
  waitingOn: { kind: "person", who: "Ana", act: "supply what it asks for", rule: null, ref: null, dueAt: null, says: { who: { key: "standing.who.named", vars: { name: "Ana" } }, act: { key: "issues.standing.act.supply" }, rule: null } },
} as unknown as IssueStanding;
const question = {
  id: "q1",
  projectId: "p1",
  issueId: "i1",
  status: "open",
  blockerKind: "human",
  steps: [{ round: 1, prompt: "The run needs a database to test against.", askedAt: "2026-10-24T00:00:00Z", answerShape: "free_text", needed: NEEDED }],
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: "2026-10-24T00:00:00Z",
  updatedAt: "2026-10-24T00:00:00Z",
  options: [],
};
const notice = {
  id: "c1",
  issueId: "i1",
  authorId: "u1",
  author: { displayName: "forge", isAgent: true },
  body: [
    "↪ **Re-pointed `needs_info`**",
    "",
    "This park is now a `needs_resource` park, waiting on something a person supplies, in place of `needs_decision`. It still returns to the status it left once every one is settled.",
    "",
    "The run needs a database to test against.",
  ].join("\n"),
  format: "markdown",
  createdAt: "2026-10-24T00:00:00Z",
  replies: [],
  attachments: [],
} as unknown as CommentNode;

const P = "11111111-1111-4111-8111-111111111111";
const decision: NeedsYouDecision = {
  id: "question:q41",
  group: "answer",
  area: "questions",
  entity: "question",
  key: "ISS-41",
  title: "Pick the dashboard's first row",
  opens: { kind: "requirement", key: "REQ-41" },
  question: "Which row leads the dashboard?",
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
  recommended: null,
  noRecommendation: "Nobody recommended an answer.",
  answers: [{ id: "a", label: "Stuck first", act: "question.answer", path: `/api/projects/${P}/questions/q41/answer`, body: {}, needsReason: false, declines: false, effect: "It answers the question.", recommended: false }],
  touchedAt: null,
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
  evidence: { requirement: { key: "REQ-41", title: "The dashboard reads as state", revision: 3 }, criteria: { count: 2, codes: [] } },
  subject: { kind: "requirement", key: "REQ-41", title: "The dashboard reads as state" },
};

window.fetch = async (input: RequestInfo | URL) =>
  String(input).includes("/questions")
    ? new Response(JSON.stringify({ questions: [question] }), { headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });

const SURFACES = ["banner", "parked", "notice", "peek"] as const;
const textOf = (name: string) => document.querySelector(`[data-witness="${name}"]`)?.textContent ?? "";

function probe(): string[] {
  const wrong: string[] = [];
  for (const name of SURFACES) {
    const text = textOf(name);
    for (const [bad, what] of [
      [/RELEASE_[A-Z_]+/, "a raw hold code"],
      [/\/api\//, "an API path"],
      [/\.\./, "a double stop"],
      [/needs_[a-z_]+/, "a raw waiting-kind code"],
      [/Decision waiting/, "a decision heading on a resource question"],
      [/supply what it asks for/, "a Needs you that names no resource"],
    ] as const) {
      const hit = bad.exec(text);
      if (hit) wrong.push(`${name} shows ${what}: "${hit[0]}"`);
    }
  }
  const peekNames = textOf("peek").split("REQ-41").length - 1;
  if (peekNames > 1) wrong.push(`the peek names REQ-41 ${peekNames} times`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "stuck-copy-1440", width: 1440 },
    { name: "stuck-copy-390", width: 390 },
  ],
  ready: () => textOf("parked").includes("database") && textOf("peek").length > 0,
  probe,
};

function Part({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section data-witness={name} className="border-b border-line-subtle py-4">
      <h2 className="mb-2 text-11-5 uppercase tracking-wide text-subtle">{name}</h2>
      {children}
    </section>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const peek = { open: "question:q41", position: { at: 1, of: 1 }, set: () => {}, move: () => {} };
createRoot(root).render(
  <InRouter>
    <QueryClientProvider client={queries}>
      <main className="mx-auto max-w-[900px] bg-app p-4">
        <Part name="banner">
          <IssueStuckBanner standing={stuck} className="rounded-md" />
        </Part>
        <Part name="parked">
          <IssueStateHead standing={parked} forecast={undefined} panels={<IssueQuestions issueId="i1" parkedForInfo waitingKind="needs_resource" show="now" />} />
        </Part>
        <Part name="notice">
          <CommentThread issueId="i1" comments={[notice]} members={undefined} readOnly />
        </Part>
        <Part name="peek">
          <div className="relative h-[640px]">
            <DecisionPeek d={decision} peek={peek} full={{ href: "/x", origin: null }} slug="hop" noun="Decision" typing={null} onType={() => {}} onPress={() => {}} />
          </div>
        </Part>
      </main>
    </QueryClientProvider>
  </InRouter>,
);
