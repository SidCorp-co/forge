// A feedback item reads every question about it on its own page (REQ-33 BC-8): the clarifications asked
// of its reporter and the steward's questions, open and answered, each with what came back; an item
// with none draws nothing, and a question whose words are withheld keeps its state and says so.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FeedbackView } from "../types";
import { FeedbackQuestions } from "./feedback-questions";

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
    render(
      <FeedbackQuestions
        f={{
          questions: [
            question({ id: "q2", kind: "steward", status: "answered", prompt: "Merge FB-12 into FB-9?", answer: "Merge" }),
            question({ id: "q1" }),
          ],
        }}
      />,
    );
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
    render(<FeedbackQuestions f={{ questions: [question({ prompt: null })] }} />);
    expect(screen.getByTestId("feedback-question")).toHaveTextContent("The question's words are withheld from you");
  });

  it("draws nothing on an item no question is about", () => {
    const { container } = render(<FeedbackQuestions f={{ questions: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
