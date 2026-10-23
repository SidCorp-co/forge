// A feedback item reads every question about it on its own page (REQ-33 BC-8): the clarifications asked
// of its reporter and the steward's questions, open and answered, each with what came back; an item
// with none draws nothing, and a question whose words are withheld keeps its state and says so. A
// question a person raised as a comment on the item (through the old Questions desk) reads there too.

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackQuestions } from "./feedback-questions";

const LIST = "/projects/p1/feedback/FB-53/comments";
const none = () => fakeCore((c) => (c.path === LIST ? { body: { comments: [], returned: 0 } } : undefined));
const show = (questions: FeedbackView["questions"]) => renderWithQuery(<FeedbackQuestions projectId="p1" f={{ key: "FB-53", questions }} />);

const AT = new Date(Date.now() - 3 * 3_600_000).toISOString();
const question = (over: Partial<FeedbackView["questions"][number]>): FeedbackView["questions"][number] => ({
  id: "q1",
  kind: "clarification",
  status: "open",
  prompt: "Which filter was set?",
  answer: null,
  askedAt: AT,
  answeredAt: null,
  ...over,
});

describe("a feedback item's questions", () => {
  it("lists each question with its state, who asked and what came back", () => {
    none();
    show([question({ id: "q2", kind: "steward", status: "answered", prompt: "Merge FB-12 into FB-9?", answer: "Merge" }), question({ id: "q1" })]);
    const section = screen.getByTestId("feedback-questions");
    expect(within(section).getByRole("heading")).toHaveTextContent("Questions · 2");
    const [steward, clarification] = within(section).getAllByTestId("feedback-question");
    expect(steward).toHaveAttribute("data-status", "answered");
    expect(steward).toHaveTextContent("Merge FB-12 into FB-9?");
    expect(steward).toHaveTextContent("Asked by the steward");
    expect(steward).toHaveTextContent("Answer: Merge");
    expect(clarification).toHaveAttribute("data-status", "open");
    expect(clarification).toHaveTextContent("Asked of the reporter");
    expect(clarification).not.toHaveTextContent("Answer:");
  });

  it("keeps a withheld question's state and says its words are withheld", () => {
    none();
    show([question({ prompt: null })]);
    expect(screen.getByTestId("feedback-question")).toHaveTextContent("The question's words are withheld from you");
  });

  it("draws nothing on an item no question is about", async () => {
    none();
    const { container } = show([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it("reads a question raised as a comment on the item, with its answer, in the same section", async () => {
    const raised = (id: string, at: string, over: object) => ({
      id,
      target: { scope: "feedback", id: "f53", key: "FB-53", title: "Filter resets" },
      intent: "question",
      body: "",
      format: "markdown",
      decision: null,
      writtenLang: null,
      parentId: null,
      author: { id: "u1", name: "Dana", agency: "human" },
      withheld: false,
      edited: false,
      createdAt: at,
      updatedAt: at,
      datedAhead: null,
      ...over,
    });
    fakeCore((c) =>
      c.path === LIST
        ? {
            body: {
              comments: [
                raised("c1", "2026-10-15T09:00:00Z", { body: "Does it reset on a phone too?" }),
                raised("c2", "2026-10-15T10:00:00Z", { intent: "note", parentId: "c1", body: "Yes, on iOS.", author: { id: "u2", name: "Lan", agency: "human" } }),
              ],
              returned: 2,
            },
          }
        : undefined,
    );
    show([question({ id: "q1" })]);
    const row = await screen.findByTestId("raised-question");
    expect(screen.getByTestId("feedback-questions")).toContainElement(row);
    expect(within(screen.getByTestId("feedback-questions")).getByRole("heading")).toHaveTextContent("Questions · 2");
    expect(row).toHaveTextContent("Does it reset on a phone too?");
    expect(within(row).getByTestId("raised-answer")).toHaveTextContent("Yes, on iOS.");
  });
});
