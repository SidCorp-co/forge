// One Needs you decisions read shaped as core's fold makes it (REQ-48 BC-11), for the Approvals page's
// tests and its witness: feedback triages routed four ways, a breakdown, two design updates, a mockup,
// a requirement sign-off, a release approval and a run's question. Every decision is parsed by the contract's own schema,
// so a fixture that drifts from what core sends fails here, not on the page.

import { type DecisionAnswer, type NeedsYouDecision, type NeedsYouDecisions, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import type { DecisionProposal } from "@forge/contracts/needs-you-proposal";

export const APPROVALS_PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const P = APPROVALS_PROJECT;
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.UTC(2026, 9, 21, 9) - hours * HOUR).toISOString();

const approve = (path: string, effect: string | null, recommended: boolean, act: DecisionAnswer["act"] = "suggestion.accept"): DecisionAnswer => ({
  id: "approve",
  label: "Approve",
  act,
  path,
  body: {},
  needsReason: false,
  declines: false,
  effect,
  recommended,
});
const decline = (path: string, act: DecisionAnswer["act"] = "suggestion.reject"): DecisionAnswer => ({
  id: "decline",
  label: "Decline",
  act,
  path,
  body: {},
  needsReason: true,
  declines: true,
  effect: "The agent reads your reason and does not propose the same again.",
  recommended: false,
});

const proposal = (p: Partial<DecisionProposal> & Pick<DecisionProposal, "verb" | "what" | "recommends">): DecisionProposal => ({
  tags: [],
  consequences: [],
  why: [],
  said: null,
  table: null,
  yields: [],
  ...p,
});

/** An agent's suggestion as the fold builds it: Approve and Decline, Approve recommended where the agent does. */
function suggestion(s: { id: string; kind: "feedback" | "requirement"; key: string; title: string; topic: NeedsYouDecision["topic"]; hours: number; p: DecisionProposal; stuck?: boolean }): NeedsYouDecision {
  const at = `/api/projects/${P}/suggestions/${s.id}`;
  return {
    id: `suggestion:${s.id}`,
    group: "approve",
    area: s.kind === "feedback" ? "feedback" : "requirements",
    entity: s.kind,
    key: s.key,
    title: s.title,
    opens: { kind: s.kind, key: s.key },
    question: s.p.what ? `${s.p.verb}: ${s.p.what}` : s.p.verb,
    recommended: s.p.recommends ? { answerId: "approve", why: "The agent recommends it as proposed.", by: "steward" } : null,
    noRecommendation: s.p.recommends ? null : "The agent asks you to check it first.",
    answers: [approve(`${at}/accept`, s.p.consequences[0] ?? null, s.p.recommends), decline(`${at}/reject`)],
    touchedAt: ago(s.hours),
    stuck: s.stuck ?? false,
    dueAt: null,
    topic: s.topic,
    proposal: s.p,
  };
}

const kind = (text: string) => ({ text, tone: "plain" as const });

const FEEDBACK: NeedsYouDecision[] = [
  suggestion({
    id: "s135",
    kind: "feedback",
    key: "FB-135",
    title: "Wedge reset sends landed in_progress issues back to open",
    topic: "feedback",
    hours: 2,
    p: proposal({
      verb: "New issue",
      what: "“Do not reset merged issues as wedges”",
      recommends: false,
      tags: [kind("Bug · medium"), { text: "Not reproduced", tone: "warn" }, { text: "≈ FB-163 80%", tone: "plain" }, kind("REQ-2 BC-10")],
      consequences: ["Issue “Do not reset merged issues as wedges” is created (bug, medium, size s)", "FB-135 moves to Planned, carried by that issue", "The reporter is told when it ships"],
      why: [
        { label: "Reproduced", value: "no; one agent report is recorded, without independent reproduction evidence." },
        { label: "Closest item", value: "FB-163 · 80% similar, judged different" },
        { label: "Criterion", value: "REQ-2 BC-10" },
        { label: "Kind", value: "Bug · medium" },
        { label: "Seen at", value: "other reconciler autonomous wedge reset" },
      ],
      said: "pipeline/reconciler.ts:selectWedgeCandidates takes every in_progress issue without a live session, so an issue that already landed is sent back to open.",
      yields: [{ kind: "new_issue", n: 1 }],
    }),
  }),
  suggestion({
    id: "s137",
    kind: "feedback",
    key: "FB-137",
    title: "Lifecycle guide says transition accepts note; strict schema refuses it",
    topic: "feedback",
    hours: 3,
    p: proposal({
      verb: "New issue",
      what: "“Align lifecycle transition guide with strict transition reason schema”",
      recommends: true,
      tags: [kind("Bug · low"), { text: "Reproduced", tone: "ok" }, { text: "≈ FB-139 81%", tone: "plain" }],
      consequences: ["Issue “Align lifecycle transition guide with strict transition reason schema” is created (bug, low, size xs)", "FB-137 moves to Planned, carried by that issue", "The reporter is told when it ships"],
      why: [
        { label: "Cause", value: "The guide names a `note` field the transition schema does not accept." },
        { label: "Fix", value: "Rename the guide's field to `reason`." },
        { label: "Kind", value: "Bug · low" },
      ],
      said: "The lifecycle guide shows { note } on transition; the call is refused naming note.",
      yields: [{ kind: "new_issue", n: 1 }],
    }),
  }),
  suggestion({
    id: "s139",
    kind: "feedback",
    key: "FB-139",
    title: "Breakdown suggestion has no rationale field for answering a rejection",
    topic: "feedback",
    hours: 4,
    p: proposal({
      verb: "Revise REQ-8",
      what: "“Add rationale and supersedes to suggestion re-proposals”",
      recommends: false,
      tags: [kind("Change request · low"), { text: "Not reproduced", tone: "warn" }],
      consequences: ["A revision of REQ-8 is drafted", "FB-139 moves to Planned, carried by that revision"],
      yields: [{ kind: "revision", n: 1 }],
    }),
  }),
  suggestion({
    id: "s131",
    kind: "feedback",
    key: "FB-131",
    title: "Agent door over REST files into the home project",
    topic: "feedback",
    hours: 5,
    p: proposal({
      verb: "Duplicate of FB-117",
      what: "Decline as a duplicate judge QA fixture that is explicitly not work.",
      recommends: true,
      tags: [kind("Bug · low"), { text: "≈ FB-117 96%", tone: "warn" }],
      consequences: ["FB-131 closes as a duplicate of FB-117", "Its reporter follows FB-117 instead"],
      yields: [{ kind: "closed", n: 1 }],
    }),
  }),
];

const BREAKDOWN = suggestion({
  id: "s48",
  kind: "requirement",
  key: "REQ-48",
  title: "Steward agent: one standing per item",
  topic: "breakdown",
  hours: 20,
  p: proposal({
    verb: "Break into 3 issues",
    what: "3 draft issues covering 9 criteria",
    recommends: true,
    tags: [kind("BC 9 of 11 traced")],
    consequences: ["3 draft issues are created, each tracing its criteria", "The master picks them up in its next pass"],
    table: {
      title: "Proposed issues",
      columns: ["Issue", "Criteria"],
      rows: [
        ["Standing and surfaces\nfeature · builds web", "BC-1 BC-2 BC-5 BC-6"],
        ["Steward runtime\nfeature · builds core", "BC-3 BC-4 BC-7"],
        ["Needs you page\nfeature · builds web", "BC-11 BC-12"],
      ],
    },
    yields: [{ kind: "draft_issue", n: 3 }],
  }),
});

function repin(base: string, title: string, revision: number, hours: number, moving: [string, string, string][]): NeedsYouDecision {
  const n = moving.length;
  const designs = `${n} ${n === 1 ? "design" : "designs"}`;
  const p = proposal({
    verb: `Follow r${revision}`,
    what: `${designs} built on it ${n === 1 ? "moves" : "move"} to its approved revision`,
    recommends: true,
    tags: [{ text: "Only the followed revision changes", tone: "ok" }],
    consequences: moving.map(([design, from, to]) => `${design} gets ${to}, following ${base} ${from} → r${revision}`),
    why: [
      { label: "Changed", value: `“${title}” was approved at r${revision}` },
      { label: "Built on it", value: `${designs} still ${n === 1 ? "follows" : "follow"} an older revision` },
      { label: "Checked", value: "Each new revision differs only in which revision it follows" },
    ],
    table: { title: "Designs that move", columns: ["Design", "Follows now", "After"], rows: moving.map(([design, from, to]) => [design, `${base} ${from}`, to]) },
    yields: [{ kind: "design_update", n }],
  });
  return {
    id: `repin:wf-${base}`,
    group: "approve",
    area: "designs",
    entity: "workflow",
    key: base,
    title,
    opens: { kind: "workflow", key: base },
    question: `Move ${designs} built on ${base} to follow r${revision}?`,
    recommended: { answerId: "approve", why: "Each new revision differs only in which revision it follows", by: "rule" },
    noRecommendation: null,
    answers: [
      {
        id: "approve",
        label: `Follow r${revision}`,
        act: "design.repin",
        path: `/api/projects/${P}/workflows/wf-${base}/design/repins`,
        body: { revision, designs: moving.map(([d], i) => ({ workflowId: `wf-${d}`, revision: 10 + i })) },
        needsReason: false,
        declines: false,
        effect: `${designs} ${n === 1 ? "is" : "are"} approved at the revision that follows r${revision}.`,
        recommended: true,
      },
    ],
    touchedAt: ago(hours),
    stuck: false,
    dueAt: null,
    topic: "design_update",
    proposal: p,
  };
}

const DESIGN_UPDATES = [
  repin("requirement-to-delivery", "Requirement to delivery", 18, 1, [["design-reconciliation", "r11", "r19"]]),
  repin("system-context", "Forge in context", 17, 312, [
    ["design-steward", "r4", "r5"],
    ["design-runner", "r9", "r10"],
  ]),
];

const MOCKUP: NeedsYouDecision = {
  id: "mockup:MK-4",
  group: "approve",
  area: "requirements",
  entity: "requirement",
  key: "REQ-49",
  title: "Mockups on the item",
  opens: { kind: "requirement", key: "REQ-49" },
  question: "Accept mockup: Approvals page",
  recommended: null,
  noRecommendation: "The agent asks you to check it first.",
  answers: [
    approve(`/api/projects/${P}/mockups/MK-4/accept`, "MK-4 is accepted for REQ-49", false, "mockup.accept"),
    decline(`/api/projects/${P}/mockups/MK-4/return`, "mockup.return"),
  ],
  touchedAt: ago(26),
  stuck: false,
  dueAt: null,
  topic: "mockup",
  proposal: proposal({
    verb: "Accept mockup",
    what: "Approvals page",
    recommends: false,
    tags: [kind("page")],
    consequences: ["MK-4 is accepted for REQ-49"],
    why: [{ label: "Proposed by", value: "forge-master" }],
    yields: [{ kind: "approved", n: 1 }],
  }),
  mockup: { key: "MK-4", url: `/api/projects/${P}/mockups/MK-4/content`, kind: "html", name: "approvals.html", round: 2, revises: "MK-3", openComments: 1, consequence: "pinned_next_baseline" },
};

const SIGN_OFF: NeedsYouDecision = {
  id: "row:REQ-41",
  group: "approve",
  area: "requirements",
  entity: "requirement",
  key: "REQ-41",
  title: "The dashboard reads as state",
  opens: { kind: "requirement", key: "REQ-41" },
  question: "Accept REQ-41 r3?",
  recommended: null,
  noRecommendation: "Nobody recommended an answer.",
  answers: [
    { id: "accept", label: "Accept r3", act: "revision.accept", path: `/api/projects/${P}/requirements/REQ-41/revisions/3/accept`, body: {}, needsReason: false, declines: false, effect: "r3 becomes the agreed revision.", recommended: false },
    { id: "return", label: "Return", act: "revision.return", path: `/api/projects/${P}/requirements/REQ-41/revisions/3/return`, body: {}, needsReason: true, declines: true, effect: "Its author revises it.", recommended: false },
  ],
  touchedAt: ago(50),
  stuck: true,
  dueAt: null,
  topic: "requirement",
  proposal: null,
};

const QUESTION: NeedsYouDecision = {
  id: "question:q41",
  group: "answer",
  area: "issues",
  entity: "issue",
  key: "ISS-41",
  title: "Bulk export",
  opens: { kind: "issue", key: "ISS-41" },
  question: "Should the export keep the old column order for existing reports?",
  recommended: { answerId: "keep", why: "Whoever asked recommends “Keep the old order”.", by: "asker" },
  noRecommendation: null,
  answers: [
    { id: "keep", label: "Keep the old order", act: "question.answer", path: "/api/questions/q41/answer", body: { round: 1, optionId: "keep" }, needsReason: false, declines: false, effect: "Sends this answer to the run that asked.", recommended: true },
    { id: "new", label: "Use the new order", act: "question.answer", path: "/api/questions/q41/answer", body: { round: 1, optionId: "new" }, needsReason: false, declines: false, effect: null, recommended: false },
  ],
  touchedAt: ago(6),
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
};

/** A release approval as core's `releaseDecision` builds it: both answers take words, and only Return declines. */
const RELEASE_PATH = `/api/projects/${P}/release-batches/run-7/approvals/ap-7/decision`;
const RELEASE: NeedsYouDecision = {
  id: "row:0.4.0-dev.270",
  group: "approve",
  area: "releases",
  entity: "release",
  key: "0.4.0-dev.270",
  title: "Approvals decline round",
  opens: { kind: "release", key: "0.4.0-dev.270" },
  question: "Approve release 0.4.0-dev.270 for production, or return it to the master?",
  recommended: { answerId: "approve", why: "None of the 4 criteria it carries is failing.", by: "rule" },
  noRecommendation: null,
  answers: [
    { id: "approve", label: "Approve 0.4.0-dev.270", act: "release.decide", path: RELEASE_PATH, body: { decision: "approve" }, needsReason: true, declines: false, effect: "The release may go to production.", recommended: true },
    { id: "return", label: "Return with a reason", act: "release.decide", path: RELEASE_PATH, body: { decision: "return" }, needsReason: true, declines: true, effect: "The master is told why and does not take it to production.", recommended: false },
  ],
  touchedAt: ago(8),
  stuck: false,
  dueAt: null,
  topic: "release",
  proposal: null,
};

const ALL = [SIGN_OFF, ...FEEDBACK, BREAKDOWN, ...DESIGN_UPDATES, MOCKUP, RELEASE, QUESTION];

/** The read the Approvals page, the Dashboard, the menu badge and /attention all count from. */
export const APPROVALS_READ: NeedsYouDecisions = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-21T09:00:00.000Z",
  total: ALL.length,
  decisions: ALL,
  notDecisions: [{ reason: "unreadable", count: 1, keys: ["FB-140"] }],
});
