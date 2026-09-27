// @vitest-environment jsdom
//
// ISS-1257 — the Questions tab is not a second inbox. It lists the decisions no
// issue carries, and a run row's link to a decision that IS on an issue lands on
// the way to that issue rather than on an empty list.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

let listed: Record<string, unknown>;
let linked: Record<string, unknown>;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/features/questions/hooks", () => ({
  useProjectQuestions: () => listed,
  useAnswerProjectQuestion: () => ({ mutateAsync: vi.fn() }),
  useAnsweringQuestions: () => ({ answering: new Set<string>(), answer: vi.fn() }),
  useLinkedQuestion: () => linked,
}));

const { QuestionsPane } = await import("./questions-pane");

const scope = { projectId: "p-1", slug: "forge-dev" };

beforeEach(() => {
  listed = {
    data: { questions: [], total: 0, hasMore: false },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  };
  linked = { gone: false, unreachable: false, data: undefined, refetch: vi.fn() };
});

describe("QuestionsPane", () => {
  it("says it holds a master's questions with no issue, and points issue questions at the issue", () => {
    render(<QuestionsPane scope={scope} />);
    expect(screen.getByText("No master is waiting on a person")).toBeInTheDocument();
    expect(screen.getByText(/waits on that issue's row in the Issues list/)).toBeInTheDocument();
  });

  it("turns a run row's link to a decision on an issue into a link to that issue", () => {
    linked = { ...linked, data: { status: "open", issueId: "iss-uuid-1" } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-on-issue" />);
    const link = screen.getByRole("link", { name: "Open the issue to answer it" });
    expect(link).toHaveAttribute("href", "/projects/forge-dev/issues/iss-uuid-1");
  });

  it("offers no issue link for a linked decision that is no longer open", () => {
    linked = { ...linked, gone: true, data: { status: "answered", issueId: "iss-uuid-1" } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-answered" />);
    expect(screen.queryByTestId("decision-on-issue")).not.toBeInTheDocument();
  });
});
