// @vitest-environment jsdom
//
// ISS-1421 r38, judge-155: the Decision waiting card showed the stored values "human" and "open" as
// tags beside its title.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentQuestion } from "../types";
import { QuestionCard } from "./question-card";

expect.extend(matchers);
afterEach(cleanup);

const QUESTION = {
  id: "q-free",
  projectId: "p-1",
  issueId: "i-1",
  status: "open",
  blockerKind: "human",
  steps: [
    {
      round: 1,
      prompt: "Which synonyms should sofa match in search?",
      askedAt: "2026-10-21T10:00:00.000Z",
      answerShape: "free_text",
      needed: "One per line",
    },
  ],
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  answerShape: "free_text",
  options: [],
  recommendedOptionId: "",
  needed: "One per line",
  locked: false,
} as unknown as AgentQuestion;

describe("the Decision waiting card's head", () => {
  it("says who the question waits on and that it is not answered, in words", () => {
    render(<QuestionCard question={QUESTION} onAnswer={vi.fn()} pending={false} />);
    expect(screen.getByText("Decision waiting")).toBeInTheDocument();
    expect(screen.getByTestId("question-state")).toHaveTextContent("Waits on a person · not answered yet");
    expect(screen.queryByText("human")).toBeNull();
    expect(screen.queryByText("open")).toBeNull();
  });

  it("says an answered question was asked of another agent, waiting on nobody", () => {
    render(
      <QuestionCard
        question={{ ...QUESTION, status: "answered", blockerKind: "master_or_peer" } as AgentQuestion}
        onAnswer={vi.fn()}
        pending={false}
      />,
    );
    expect(screen.getByTestId("question-state")).toHaveTextContent("Asked of another agent · answered");
  });
});
