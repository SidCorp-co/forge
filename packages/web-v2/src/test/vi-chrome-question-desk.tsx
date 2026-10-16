import type { RaisedQuestionsResponse } from "@forge/contracts/comments";
import { fireEvent, screen } from "@testing-library/react";
import { QuestionDesk } from "@/features/question-desk";
import { Seeded } from "./vi-chrome-requirements";
import type { ChromeScreen } from "./vi-chrome-screens";

// The Questions page for the vi walking test: a question waiting on the reader, the questions raised
// (owed to the agent and to members; the answered and closed ones folded to counts, then opened) and the form that raises one. A
// question, an answer and a title are what a person wrote, so they are placeholder words here.

const P = "p1";
const AT = "2026-10-15T08:00:00.000Z";
const LAN = { id: "u1", name: "Lan", agency: "human" as const };

const DECISIONS = {
  generatedAt: AT,
  total: 1,
  decisions: [
    {
      group: "answer",
      area: "issues",
      entity: "issue",
      key: "ISS-1",
      title: "Xuat du lieu",
      opens: { kind: "issue", key: "ISS-1" },
      question: "Giu dinh dang cu?",
      recommended: null,
      noRecommendation: "Chua co",
      answers: [{ id: "giu", label: "Giu", act: "question.answer", path: "/api/questions/q1/answer", body: { round: 1, optionId: "giu" }, needsReason: false, effect: null, recommended: false }],
      touchedAt: AT,
    },
  ],
  notDecisions: [],
};

const target = (scope: "requirement" | "issue" | "feedback", key: string) => ({ scope, id: `t-${key}`, key, title: `Muc ${key}` });

const ROWS: RaisedQuestionsResponse["questions"] = [
    { id: "q1", target: target("requirement", "REQ-7"), summary: "Cau hoi mot", author: LAN, askedAt: AT, state: "owed", answer: null, owedBy: "members", withheld: false },
    { id: "q2", target: target("issue", "ISS-9"), summary: "Cau hoi hai", author: LAN, askedAt: AT, state: "owed", answer: null, owedBy: "agent", withheld: false },
    { id: "q3", target: target("issue", "ISS-4"), summary: null, author: LAN, askedAt: AT, state: "closed", answer: null, owedBy: null, withheld: true },
    { id: "q4", target: target("feedback", "FB-2"), summary: "Cau hoi bon", author: LAN, askedAt: AT, state: "answered", answer: { id: "a4", summary: "Tra loi", author: { id: "u2", name: "Minh", agency: "human" }, at: AT }, owedBy: null, withheld: false },
];

/** One state's first page as the page reads it (an infinite read), the counts over all of them; closed holds 21, so a Show more is drawn. */
const page = (state: "owed" | "answered" | "closed") => ({
  pages: [{ by: "me", owed: 2, answered: 1, closed: 21, questions: ROWS.filter((q) => q.state === state) }],
  pageParams: [0],
});

const desk = () => (
  <Seeded
    data={[
      [["needs-you", P, "decisions"], DECISIONS],
      [["raised-questions", P, "me", "owed"], page("owed")],
      [["raised-questions", P, "me", "answered"], page("answered")],
      [["raised-questions", P, "me", "closed"], page("closed")],
      [["question-targets", P, "requirement"], [{ ref: "REQ-7", label: "REQ-7 · Muc" }]],
    ]}
  >
    <QuestionDesk projectId={P} slug="hop" />
  </Seeded>
);

export const SCREENS: ChromeScreen[] = [
  { name: "Questions page", render: desk },
  { name: "Questions page, raising one", render: desk, act: () => fireEvent.click(screen.getByTestId("question-desk-ask")) },
  {
    name: "Questions page, answered and closed opened",
    render: desk,
    act: () => {
      fireEvent.click(screen.getByTestId("raised-group-answered"));
      fireEvent.click(screen.getByTestId("raised-group-closed"));
    },
  },
];
