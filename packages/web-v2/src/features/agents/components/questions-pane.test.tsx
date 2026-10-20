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

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace }) }));
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
  replace.mockClear();
});

describe("QuestionsPane", () => {
  it("says it holds a master's questions with no issue, and points issue questions at the issue", () => {
    render(<QuestionsPane scope={scope} />);
    expect(screen.getByText("Nothing is waiting on a person")).toBeInTheDocument();
    expect(screen.getByText(/waits on that issue's row in the Issues list/)).toBeInTheDocument();
  });

  it("sends a run row's link to an open decision on an issue straight to that issue", () => {
    linked = { ...linked, data: { status: "open", issueId: "iss-uuid-1" } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-on-issue" />);
    expect(replace).toHaveBeenCalledWith("/projects/forge-dev/issues/iss-uuid-1");
    expect(screen.queryByText("Nothing is waiting on a person")).not.toBeInTheDocument();
  });

  it("sends a link to an answered decision on an issue to that issue too", () => {
    linked = { ...linked, gone: true, data: { status: "answered", issueId: "iss-uuid-1" } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-answered" />);
    expect(replace).toHaveBeenCalledWith("/projects/forge-dev/issues/iss-uuid-1");
  });

  it("stays on the tab for a linked decision that names no issue", () => {
    linked = { ...linked, gone: true, data: { status: "answered", issueId: null } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-master" />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Nothing is waiting on a person")).toBeInTheDocument();
  });

  // ISS-1228 r20 (judge-62): a question an issue's job stopped on read "asked by a master — no issue behind it".
  const question = (askedBy: unknown) => ({
    id: "q-1",
    projectId: "p-1",
    issueId: null,
    status: "open",
    blockerKind: "human",
    currentStep: null,
    rounds: 1,
    maxRounds: 3,
    voidReason: null,
    endedReason: null,
    parkDeadlineAt: null,
    createdAt: "2026-10-20T04:08:55.000Z",
    updatedAt: "2026-10-20T04:08:55.000Z",
    answerShape: "free_text",
    options: [],
    recommendedOptionId: "",
    needed: "Which database should the scratch migration target?",
    locked: false,
    askedBy,
  });
  const listing = (q: unknown) => ({ ...listed, data: { questions: [q], total: 1, hasMore: false } });

  it("names the issue a job's question holds up, linking it, and the kind of work that asked", () => {
    listed = listing(question({ jobType: "drive", issueId: "iss-uuid-5", issueRef: "ISS-5", issueTitle: "Scratch" }));
    render(<QuestionsPane scope={scope} />);
    const link = screen.getByRole("link", { name: "ISS-5" });
    expect(link).toHaveAttribute("href", "/projects/forge-dev/issues/iss-uuid-5");
    expect(link.parentElement?.textContent).toBe("Asked by Issue work on ISS-5");
    expect(screen.queryByText(/asked by a master/)).toBeNull();
  });

  it("keeps a master's question reading as one with no issue behind it", () => {
    listed = listing(question(null));
    render(<QuestionsPane scope={scope} />);
    expect(screen.getByText("asked by a master — no issue behind it")).toBeInTheDocument();
  });
});
