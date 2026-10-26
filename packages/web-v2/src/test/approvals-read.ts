// One Needs you decisions read shaped as core's fold makes it (REQ-48 BC-11), for the Approvals page's
// tests and its witness: feedback triages routed four ways, a breakdown, two design updates, a mockup,
// a requirement sign-off, a release approval and a run's question. Every decision is parsed by the contract's own schema,
// so a fixture that drifts from what core sends fails here, not on the page.

import { type DecisionAnswer, type NeedsYouDecision, type NeedsYouDecisions, needsYouDecisionSchema, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import type { DecisionProposal } from "@forge/contracts/needs-you-proposal";
import { STEWARD_DECISION_OPTION_IDS, STEWARD_DECISIONS_WITH_REASON, stewardDecisionEffect, stewardDecisionLabel, stewardDecisionQuestion } from "@forge/contracts/steward";

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
    changes: "What happens next on it",
    impact: "It waits on this until it is decided.",
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
    changes: "What happens next on it",
    impact: "It waits on this until it is decided.",
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
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
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
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
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
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
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

/** One answer of the steward's question on ISS-7, as core's `stewardDecision` builds it: Forge's own label and effect. */
const ISS_7 = { kind: "issue" as const, key: "ISS-7", draft: true };
const stewardAnswer = (decision: keyof typeof STEWARD_DECISION_OPTION_IDS, recommended: boolean): DecisionAnswer => ({
  id: STEWARD_DECISION_OPTION_IDS[decision],
  label: stewardDecisionLabel(decision, ISS_7),
  act: "question.answer",
  path: "/api/questions/q7/answer",
  body: { round: 1, optionId: STEWARD_DECISION_OPTION_IDS[decision] },
  needsReason: STEWARD_DECISIONS_WITH_REASON.includes(decision),
  declines: false,
  effect: stewardDecisionEffect(decision, { ...ISS_7, option: STEWARD_DECISION_OPTION_IDS[decision] }),
  recommended,
});

/**
 * The steward's question on a stuck draft (REQ-48 BC-5, BC-11): open, keep or drop, recommended by the
 * steward with its one line, each answer saying what it does to ISS-7. Not in `APPROVALS_READ`, whose
 * counts the pages' tests read; the steward's own witness and tests add it.
 */
export const STEWARD_DECISION: NeedsYouDecision = needsYouDecisionSchema.parse({
  id: "question:q7",
  group: "answer",
  area: "issues",
  entity: "issue",
  key: "ISS-7",
  title: "Export keeps the old column order",
  opens: { kind: "issue", key: "ISS-7" },
  question: stewardDecisionQuestion([STEWARD_DECISION_OPTION_IDS.open, STEWARD_DECISION_OPTION_IDS.keep, STEWARD_DECISION_OPTION_IDS.drop], ISS_7),
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
  recommended: { answerId: STEWARD_DECISION_OPTION_IDS.open, why: "Its plan and criteria pass the issue-ready check.", by: "steward" },
  noRecommendation: null,
  answers: [stewardAnswer("open", true), stewardAnswer("keep", false), stewardAnswer("drop", false)],
  touchedAt: ago(3),
  stuck: true,
  dueAt: null,
  topic: "question",
  proposal: null,
});

/**
 * The steward's question on ISS-625 as core builds it after REQ-48 r3 (BC-13..16): one sentence from its
 * options, the reason once, four answers, one a merge into an issue about the same thing whose label
 * runs long and whose effect names what the two share, and the evidence it rests on.
 */
const ISS_625 = { kind: "issue" as const, key: "ISS-625", draft: true };
const Q625 = "/api/questions/q625/answer";
const MERGE_625 = "steward.merge:ISS-630";
const answer625 = (id: string, label: string, decision: Parameters<typeof stewardDecisionEffect>[0], recommended: boolean): DecisionAnswer => ({
  id,
  label,
  act: "question.answer",
  path: Q625,
  body: { round: 1, optionId: id },
  needsReason: STEWARD_DECISIONS_WITH_REASON.includes(decision),
  declines: false,
  effect: stewardDecisionEffect(decision, { ...ISS_625, option: id, shares: decision === "merge" ? "how a criterion traces a BC with a trailing tag." : null }),
  recommended,
});
export const STEWARD_625_REASON = "ISS-625 now links agreed REQ-48 revision 2 and has a plan and three traced BC-5 criteria, so it is ready for a person to open.";
const ANSWERS_625 = [STEWARD_DECISION_OPTION_IDS.open, MERGE_625, STEWARD_DECISION_OPTION_IDS.keep, STEWARD_DECISION_OPTION_IDS.drop];
export const STEWARD_625: NeedsYouDecision = needsYouDecisionSchema.parse({
  id: "issue:ISS-625:question.answer",
  group: "answer",
  area: "issues",
  entity: "issue",
  key: "ISS-625",
  title: "Issue criterion BC trace syntax is undocumented; a trailing tag silently traces nothing",
  opens: { kind: "issue", key: "ISS-625" },
  question: stewardDecisionQuestion(ANSWERS_625, ISS_625),
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
  recommended: { answerId: STEWARD_DECISION_OPTION_IDS.open, why: STEWARD_625_REASON, by: "steward" },
  noRecommendation: null,
  answers: [
    answer625(STEWARD_DECISION_OPTION_IDS.open, stewardDecisionLabel("open", ISS_625), "open", true),
    answer625(MERGE_625, "Merge it into ISS-630: A criterion's trailing BC tag traces nothing and no guide says how a trace is written", "merge", false),
    answer625(STEWARD_DECISION_OPTION_IDS.keep, stewardDecisionLabel("keep", ISS_625), "keep", false),
    answer625(STEWARD_DECISION_OPTION_IDS.drop, stewardDecisionLabel("drop", ISS_625), "drop", false),
  ],
  touchedAt: ago(1),
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
  evidence: {
    requirement: { key: "REQ-48", title: "An agent stands at every Product and Delivery handoff", revision: 2 },
    plan: true,
    criteria: { count: 3, codes: ["BC-5"] },
  },
});

/** A release approval as core's `releaseDecision` builds it: both answers take words, and only Return declines.
 *  It ships by merging change requests (REQ-63), so it says which, in order, each with its link. */
const RELEASE_PATH = `/api/projects/${P}/release-batches/run-7/approvals/ap-7/decision`;
const RELEASE: NeedsYouDecision = {
  id: "row:0.4.0-dev.270",
  group: "approve",
  area: "releases",
  entity: "release",
  key: "0.4.0-dev.270",
  title: "Approvals decline round",
  opens: { kind: "release", key: "0.4.0-dev.270" },
  question: "Accept this release, so the master merges !5008, !5009 in that order, or return it to the master?",
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
  recommended: { answerId: "approve", why: "None of the 4 criteria it carries is failing.", by: "rule" },
  noRecommendation: null,
  answers: [
    { id: "approve", label: "Approve 0.4.0-dev.270", act: "release.decide", path: RELEASE_PATH, body: { decision: "approve" }, needsReason: true, declines: false, effect: "The master merges !5008, !5009 in that order; nothing merges before.", recommended: true },
    { id: "return", label: "Return with a reason", act: "release.decide", path: RELEASE_PATH, body: { decision: "return" }, needsReason: true, declines: true, effect: "The master is told why and merges nothing.", recommended: false },
  ],
  touchedAt: ago(8),
  stuck: false,
  dueAt: null,
  topic: "release",
  proposal: null,
  changeRequests: [
    { label: "!5008", url: "https://gitlab.com/sidcorp-it/canawan-api/-/merge_requests/5008", state: "open", order: 1, issues: ["ISS-1", "ISS-4", "ISS-5"] },
    { label: "!5009", url: "https://gitlab.com/sidcorp-it/canawan-api/-/merge_requests/5009", state: "open", order: 2, issues: ["ISS-10", "ISS-11", "ISS-12", "ISS-13"] },
  ],
};

const ALL = [SIGN_OFF, ...FEEDBACK, BREAKDOWN, ...DESIGN_UPDATES, MOCKUP, RELEASE, QUESTION];

/** The read the Approvals page, the Dashboard, the menu badge and /attention all count from. */
export const APPROVALS_READ: NeedsYouDecisions = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-21T09:00:00.000Z",
  total: ALL.length,
  decisions: ALL,
  notDecisions: [
    { reason: "unreadable", count: 1, items: [{ key: "FB-140", title: "FB-140", next: "open it on its own page", opens: null }] },
    {
      reason: "work",
      count: 2,
      items: [
        { key: "issue-lifecycle", title: "Issue lifecycle", next: "update the design to the contract", opens: { kind: "workflow", key: "issue-lifecycle" } },
        { key: "personal-data-flow", title: "Personal data flow", next: "check its criteria", opens: { kind: "workflow", key: "personal-data-flow" } },
      ],
    },
  ],
});
