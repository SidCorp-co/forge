// The Approvals peek names the requirement a decision rests on once (ISS-680, FB-281; ui-copy-rule 3):
// a question about REQ-n whose evidence is REQ-n rn says it in the evidence alone, never again as an
// "About REQ-n" line under the question. A subject the evidence does not carry keeps its line.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-peek.tsx

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DecisionPeek } from "./components/approval-peek";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "11111111-1111-4111-8111-111111111111";

const decision = (subject: NeedsYouDecision["subject"]): NeedsYouDecision => ({
  id: "question:q41",
  group: "answer",
  area: "issues",
  entity: "issue",
  key: "ISS-41",
  title: "Pick the dashboard's first row",
  opens: { kind: "issue", key: "ISS-41" },
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
}) as NeedsYouDecision;

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
