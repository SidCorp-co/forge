// @vitest-environment jsdom
//
// The panel's one dangerous property: what it says when it finds nothing.
//
// Until ISS-1210 an empty list produced "This issue was parked without a
// question" — a claim about the record, made by a component that had read only
// one thing: that the query came back empty. An owner read it on an issue whose
// thread carried the question in full and stopped for nineteen hours. So the
// wording is asserted here, in both directions: what it must say, and what it
// must never say again.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionPanel } from "./decision-panel";

expect.extend(matchers);
afterEach(cleanup);

let questionsQuery: Record<string, unknown>;

vi.mock("../hooks", () => ({
  useIssueQuestions: () => questionsQuery,
  useAnswerQuestion: () => ({ mutateAsync: vi.fn() }),
  useAnsweringQuestions: () => ({ answering: new Set<string>(), answer: vi.fn() }),
}));

function found(questions: unknown[]) {
  return {
    data: { questions },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  questionsQuery = found([]);
});

describe("DecisionPanel, on an issue parked for information with no question", () => {
  it("reports what it queried rather than what the absence means", () => {
    render(<DecisionPanel issueId="i-1" parkedForInfo />);
    expect(screen.getByText(/No decision round on this issue/i)).toBeInTheDocument();
    expect(
      screen.getByText(/lists the questions filed against this issue, and there are none/i),
    ).toBeInTheDocument();
  });

  it("never tells the reader the issue was parked without a question", () => {
    const { container } = render(<DecisionPanel issueId="i-1" parkedForInfo />);
    expect(container.textContent ?? "").not.toMatch(/parked without a question/i);
    expect(container.textContent ?? "").not.toMatch(/Nothing to answer here/i);
  });

  it("keeps the way forward as the card's content", () => {
    render(<DecisionPanel issueId="i-1" parkedForInfo />);
    expect(screen.getByText(/Move the issue on from the header/i)).toBeInTheDocument();
    expect(screen.getByText(/A comment does not restart the run/i)).toBeInTheDocument();
  });

  it("points the reader at the thread, which is where a run that asked in prose left it", () => {
    render(<DecisionPanel issueId="i-1" parkedForInfo />);
    expect(screen.getByText(/read the comments/i)).toBeInTheDocument();
  });

  it("renders nothing at all on an issue that is not parked for information", () => {
    const { container } = render(<DecisionPanel issueId="i-1" />);
    expect(container.textContent ?? "").toBe("");
  });
});

describe("DecisionPanel, when the query itself could not be made", () => {
  it("says the load failed instead of saying there is nothing to answer", () => {
    questionsQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("network"),
      refetch: vi.fn(),
    };
    const { container } = render(<DecisionPanel issueId="i-1" parkedForInfo />);
    expect(screen.getByText(/Couldn't load this issue's decisions/i)).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/No decision round/i);
  });
});
