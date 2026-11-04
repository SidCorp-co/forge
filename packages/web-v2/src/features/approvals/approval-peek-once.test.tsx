// The Approvals peek names the requirement a decision rests on once (ISS-680, FB-281; ui-copy-rule 3):
// a question about REQ-n whose evidence is REQ-n rn says it in the evidence alone, never again as an
// "About REQ-n" line under the question. A subject the evidence does not carry keeps its line.
// A question's own key is its id, so its head names none (ISS-687 round 5: a uuid read beside
// "Feedback"). Planted red by drawing `d.key` in the head again.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-peek.tsx

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { screen } from "@testing-library/react";
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
    const text = draw({ ...decision(null), opens: { kind: "feedback", key: "FB-147" }, evidence: null });
    expect(text).not.toContain(QID);
    expect(screen.getByTestId("peek-head")).toHaveTextContent("Decision");
  });

  it("keeps the key in the head of a decision that is not a question", () => {
    draw({ ...decision(null), entity: "release", key: "v1.2.0" });
    expect(screen.getByTestId("peek-head")).toHaveTextContent("v1.2.0");
  });
});
