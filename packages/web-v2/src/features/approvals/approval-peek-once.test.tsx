// The Approvals peek names the requirement a decision rests on once (ISS-680, FB-281; ui-copy-rule 3):
// a question about REQ-n whose evidence is REQ-n rn says it in the evidence alone, never again as an
// "About REQ-n" line under the question. A subject the evidence does not carry keeps its line.
// A question's own key is its id, so its head names none (ISS-687 round 5: a uuid read beside
// "Feedback"). Planted red by drawing `d.key` in the head again.
//
// ISS-680 c5: every decision kind opening a requirement whose evidence names it says its key once, in
// Rests on, in the face and inside the Technical fold, in English and Vietnamese. The fixtures are
// what core now sends (`needs-you-names-once.test.ts`): its own words call it "the requirement". A
// decision on the requirement itself leaves its key to Rests on and its title to the head. Planted
// red on dev's peek (db0ee7261): the head said REQ-74 beside Rests on, and the title twice.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-peek.tsx

import type { DecisionAnswer, NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DecisionPeek } from "./components/approval-peek";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "11111111-1111-4111-8111-111111111111";

const QID = "1152a5c3-0abf-4685-854f-d0cee04f7447";

const decision = (subject: NeedsYouDecision["subject"]): NeedsYouDecision => ({
  id: "question:q41",
  group: "answer",
  area: "questions",
  entity: "question",
  key: QID,
  title: "Pick the dashboard's first row",
  opens: { kind: "requirement", key: "REQ-41" },
  question: "Which row leads the dashboard?",
  changes: "What happens next on it",
  impact: "It waits on this until it is decided.",
  recommended: null,
  noRecommendation: "Nobody recommended an answer.",
  answers: [
    { id: "a", label: "Stuck first", act: "question.answer", path: `/api/projects/${P}/questions/q41/answer`, body: {}, needsReason: false, declines: false, effect: "It answers the question.", recommended: false },
  ],
  touchedAt: null,
  stuck: false,
  dueAt: null,
  topic: "question",
  proposal: null,
  evidence: { requirement: { key: "REQ-41", title: "The dashboard reads as state", revision: 3 }, criteria: { count: 2, codes: [] } },
  ...(subject ? { subject } : {}),
});

const peek = { open: "question:q41", position: { at: 1, of: 1 }, set: () => {}, move: () => {} };

function draw(d: NeedsYouDecision) {
  renderWithQuery(<DecisionPeek d={d} peek={peek} full={{ href: "/x", origin: null }} slug="hop" noun="Decision" typing={null} onType={() => {}} onPress={() => {}} />);
  return screen.getByTestId("approval-peek").textContent ?? "";
}

const count = (text: string, word: string) => text.split(word).length - 1;

describe("the Approvals peek names the linked requirement once", () => {
  it("says REQ-41 in the evidence alone where the question is about REQ-41", () => {
    const text = draw(decision({ kind: "requirement", key: "REQ-41", title: "The dashboard reads as state" }));
    expect(count(text, "REQ-41")).toBe(1);
    expect(count(text, "The dashboard reads as state")).toBe(1);
    expect(screen.queryByTestId("question-subject")).toBeNull();
  });

  it("keeps the About line for a subject the evidence does not name", () => {
    draw(decision({ kind: "feedback", key: "FB-9", title: "Rows read as prose" }));
    expect(screen.getByTestId("question-subject")).toHaveTextContent("FB-9");
  });
});

describe("the Approvals peek shows no question's id", () => {
  it("names the kind of item in the head and no key, where the decision is a question", () => {
    const text = draw({ ...decision(undefined), opens: { kind: "feedback", key: "FB-147" }, evidence: undefined });
    expect(text).not.toContain(QID);
    expect(screen.getByTestId("peek-head")).toHaveTextContent("Decision");
  });

  it("keeps the key in the head of a decision that is not a question", () => {
    draw({ ...decision(undefined), entity: "release", key: "v1.2.0" });
    expect(screen.getByTestId("peek-head")).toHaveTextContent("v1.2.0");
  });
});

const KEY = "REQ-74";
const TITLE = "Approvals read as one decision each";
const EVIDENCE: NeedsYouDecision["evidence"] = { requirement: { key: KEY, title: TITLE, revision: 2 }, criteria: { count: 3, codes: ["BC-1", "BC-2"] } };
const reply = (id: string, label: string, effect: string | null, over: Partial<DecisionAnswer> = {}): DecisionAnswer => ({
  id,
  label,
  act: "question.answer",
  path: `/api/questions/${QID}/answer`,
  body: { round: 1, optionId: id },
  needsReason: false,
  declines: false,
  effect,
  recommended: false,
  ...over,
});

/** A decision opening REQ-74 as core now builds it: its own words say "the requirement". */
const onReq = (over: Partial<NeedsYouDecision>): NeedsYouDecision => ({
  id: "x",
  group: "approve",
  area: "requirements",
  entity: "requirement",
  key: KEY,
  title: TITLE,
  opens: { kind: "requirement", key: KEY },
  question: "Accept revision 3 of the requirement, or return it to its author?",
  changes: "Which revision of the requirement is current",
  impact: "The requirement waits on this; delivery plans from the current revision.",
  recommended: null,
  noRecommendation: "The revision says nothing of why.",
  answers: [reply("accept", "Accept revision 3", "Revision 3 becomes the current revision of the requirement.", { act: "revision.accept", path: `/api/projects/${P}/requirements/${KEY}/revisions/3/accept`, body: {}, needsReason: true })],
  touchedAt: null,
  stuck: false,
  dueAt: null,
  topic: "requirement",
  proposal: null,
  evidence: EVIDENCE,
  ...over,
});

const asked = { group: "answer", topic: "question", changes: "What the run that asked on the requirement goes on with", impact: "The requirement waits on this; it goes on once it has your answer." } as const;
const KINDS: [string, NeedsYouDecision][] = [
  ["a question about it, with plain text", onReq({ ...asked, entity: "question", key: QID, title: "A question a run asked", question: "Which row leads the list?", plain: "Pick which row comes first.", subject: { kind: "requirement", key: KEY, title: TITLE }, answers: [reply("stuck", "Stuck first", null)] })],
  ["a question about it, with none", onReq({ ...asked, entity: "question", key: QID, title: "A question a run asked", question: "Which row leads the list?", plain: null, subject: { kind: "requirement", key: KEY, title: TITLE }, answers: [reply("stuck", "Stuck first", null)] })],
  ["a question on it, with plain text", onReq({ ...asked, question: "Which row leads the list?", plain: "Pick which row comes first.", answers: [reply("stuck", "Stuck first", null)] })],
  [
    "the steward's withdraw",
    onReq({
      ...asked,
      question: "Withdraw the draft revision, or keep it?",
      changes: "Whether the requirement keeps its draft revision",
      impact: "The requirement waits on this; delivery goes on reading its current revision.",
      plain: null,
      recommended: { answerId: "steward.withdraw", why: "Nobody has touched the draft in 30 days.", by: "steward" },
      noRecommendation: null,
      answers: [
        reply("steward.withdraw", "Withdraw it", "Withdraws the requirement's draft revision as you, with your reason; what was agreed stays.", { needsReason: true, recommended: true }),
        reply("steward.keep", "Keep it", "Keeps the requirement as it is until its standing moves, with your reason; the steward does not ask again until then.", { needsReason: true }),
      ],
    }),
  ],
  ["a revision to accept", onReq({})],
  ["a requirement to agree", onReq({ question: "Agree the requirement at revision 2, or drop it?", changes: "Whether the requirement is built", impact: "The requirement waits on this; only an agreed requirement goes to delivery.", answers: [reply("agree", "Agree revision 2", "The requirement is agreed at revision 2 and goes to delivery.", { act: "requirement.agree", path: `/api/projects/${P}/requirements/${KEY}/agree`, body: { revision: 2 }, needsReason: true })] })],
  ["a delivery to accept", onReq({ group: "accept", question: "Accept the delivery of the requirement at revision 2?", changes: "Whether the requirement at revision 2 reads as delivered", impact: "The requirement waits on this; its readers see Delivered only once it is accepted.", answers: [reply("accept", "Accept revision 2", "The requirement is accepted as delivered.", { act: "requirement.accept", path: `/api/projects/${P}/requirements/${KEY}/accept`, body: { revision: 2 } })] })],
  ["a re-pin", onReq({ question: "Follow the approved designs and contracts in the requirement at revision 4?", changes: "Which design and contract versions the requirement pins", impact: "The requirement waits on this; its issues are planned against the versions it pins.", answers: [reply("repin", "Update to the approved versions", "The requirement follows the approved designs and contracts; delivery reads them next.", { act: "requirement.repin", path: `/api/projects/${P}/requirements/${KEY}/repin`, body: { revision: 4 }, needsReason: true })] })],
  [
    "a question escalated after 14 days",
    onReq({
      ...asked,
      question: "Which row leads the list?",
      plain: null,
      changes: "Whether the requirement waits on this answer, leaves the current release, or is dropped",
      impact: "The requirement has waited 14 days on this; an answer lets it go on.",
      recommended: { answerId: "escalation.defer", why: "No answer in 14 days, so the agent proposes deferring the requirement until someone can answer.", by: "rule" },
      noRecommendation: null,
      answers: [
        reply("escalation.defer", "Defer the requirement", "The requirement leaves the current release and waits as deferred.", { act: "requirement.defer", path: `/api/projects/${P}/requirements/${KEY}/defer`, body: {}, needsReason: true, recommended: true }),
        reply("escalation.drop", "Drop the requirement", "The requirement is dropped and will not be built.", { act: "requirement.drop", path: `/api/projects/${P}/requirements/${KEY}/drop`, body: {}, needsReason: true, declines: true }),
      ],
    }),
  ],
];

/** The peek's whole text, with the Technical fold opened where it has one. */
function drawn(d: NeedsYouDecision): string {
  cleanup();
  renderWithQuery(
    <DecisionPeek d={d} peek={peek} full={{ href: "/x", origin: null }} slug="hop" noun="Decision" typing={null} onType={() => {}} onPress={() => {}} />,
  );
  const fold = screen.queryByTestId("approval-peek-technical");
  const trigger = fold?.querySelector("button");
  if (trigger) fireEvent.click(trigger);
  return screen.getByTestId("approval-peek").textContent ?? "";
}

describe("every decision opening a requirement names it once, in Rests on (ISS-680 c5)", () => {
  it.each(KINDS)("%s", (_, d) => {
    const text = drawn(d);
    expect(count(text, KEY)).toBe(1);
    expect(count(text, TITLE)).toBe(1);
    expect(screen.getByTestId("approval-peek-evidence")).toHaveTextContent(`${KEY} revision 2`);
    expect(screen.getByTestId("peek-head")).not.toHaveTextContent(KEY);
  });
});
