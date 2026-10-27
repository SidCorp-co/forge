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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionPanel, focusDecisionPanel } from "./decision-panel";

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
    expect(screen.getByText(/No questions on this issue/i)).toBeInTheDocument();
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
    expect(screen.getByRole("region", { name: "Decisions" })).toHaveTextContent("Couldn't load");
    expect(container.textContent ?? "").not.toMatch(/No questions on this issue/i);
  });

  // ISS-1228 r25 (criterion 251): the failure was a full-height block, mascot and heading, at the top
  // of the main column. It is one flat line in its own Decisions section, with Retry.
  it("says so on one flat line in a Decisions section, with Retry and the reason", () => {
    const refetch = vi.fn();
    questionsQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(503, "The server is busy.", "UNAVAILABLE"),
      refetch,
    };
    render(<DecisionPanel issueId="i-1" />);
    const line = screen.getByRole("region", { name: "Decisions" });
    expect(line).toHaveTextContent("The server is busy.");
    expect(line.className).toContain("border-t");
    expect(line.className).not.toMatch(/\bpy-12\b|\brounded-lg\b/);
    expect(screen.queryByRole("heading", { level: 3, name: /Couldn't load/ })).toBeNull();
    expect(screen.queryByText(/Couldn't load this issue's decisions/)).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  // ISS-1229 r50 (criterion 478): Retry only where a second read can change the answer.
  it("offers no Retry where Forge refused the read for good", () => {
    questionsQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(403, "Not a project member.", "FORBIDDEN"),
      refetch: vi.fn(),
    };
    render(<DecisionPanel issueId="i-1" />);
    expect(screen.getByRole("region", { name: "Decisions" })).toHaveTextContent("Not a project member.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers no Retry where Forge answered 401", () => {
    questionsQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(401, "Unauthenticated", "UNAUTHENTICATED"),
      refetch: vi.fn(),
    };
    render(<DecisionPanel issueId="i-1" />);
    expect(within(screen.getByRole("region", { name: "Decisions" })).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// ISS-1310, finding bed1c82b — a park that asked only in the thread is shown, and answered, here.
describe("DecisionPanel, on a park whose question is only in the thread", () => {
  const asked = {
    prompt: "Who holds a release's lease: the door, or the issue's own run?",
    why: "the release lease has no owner",
    readings: [
      { choice: "the door", outcome: "one lease per release" },
      { choice: "the run", outcome: "the release waits on it" },
    ],
    answer: null,
  };

  it("shows the sentence asked, why it stopped, and each choice with where it leads", () => {
    const { container } = render(
      <DecisionPanel issueId="i-1" parkedForInfo threadQuestion={asked} onAnswerInThread={vi.fn()} />,
    );
    expect(screen.getByText(asked.prompt)).toBeInTheDocument();
    expect(screen.getByText(asked.why)).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["the door — one lease per release", "the run — the release waits on it"]);
    expect(container.textContent ?? "").not.toContain("->");
    expect(container.textContent ?? "").not.toMatch(/\b(park|parked|rung|decision round)\b/i);
    expect(screen.queryByText(/No questions on this issue/i)).toBeNull();
  });

  // j2: a person's own reason, typed when they moved the issue, was shown as something the run asked.
  it("does not say the run wrote the sentence, which a person may have typed", () => {
    const { container } = render(
      <DecisionPanel issueId="i-1" parkedForInfo threadQuestion={asked} onAnswerInThread={vi.fn()} />,
    );
    expect(container.textContent ?? "").not.toMatch(/\bthe run\b asked/i);
    expect(screen.getByText(/written in the comments when the issue stopped/i)).toBeInTheDocument();
  });

  it("shows the answer a person gave and no box, once one is on the thread", () => {
    const answered = {
      ...asked,
      answer: { commentId: "c9", postedAt: "2026-09-30T00:00:00.000Z", text: "the door" },
    };
    render(
      <DecisionPanel issueId="i-1" parkedForInfo threadQuestion={answered} onAnswerInThread={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Answered in the comments\s*the door/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Post answer" })).toBeNull();
  });

  it("posts the typed answer and says where it went", async () => {
    const onAnswerInThread = vi.fn(async () => ({}));
    render(
      <DecisionPanel issueId="i-1" parkedForInfo threadQuestion={asked} onAnswerInThread={onAnswerInThread} />,
    );
    const post = () => screen.getByRole("button", { name: "Post answer" });
    expect(post()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "the door" } });
    fireEvent.click(post());
    expect(onAnswerInThread).toHaveBeenCalledWith("the door");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/on the thread/));
  });

  it("shows the question with no answer box to a reader who may not write", () => {
    render(<DecisionPanel issueId="i-1" parkedForInfo threadQuestion={asked} />);
    expect(screen.getByText(asked.prompt)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post answer" })).toBeNull();
  });
});

describe("focusDecisionPanel", () => {
  it("scrolls the questions to sit below the sticky header rather than under it", () => {
    const panel = document.createElement("div");
    panel.id = "issue-decisions";
    const scrolled = vi.fn();
    panel.scrollIntoView = scrolled;
    document.body.append(panel);
    const header = document.createElement("div");
    Object.defineProperty(header, "offsetHeight", { value: 148 });
    focusDecisionPanel(header);
    expect(panel.style.scrollMarginTop).toBe("160px");
    expect(scrolled).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    panel.remove();
  });
});

// ISS-1228 r26 (judge-83, criteria 233 and 263): one failed 30 s poll replaced the question card with
// the failure line, and what a person had typed into its answer box went with it; Retry brought the
// card back empty.
describe("DecisionPanel, when a refresh fails after it answered", () => {
  const FREE_TEXT = {
    id: "q-free",
    projectId: "p-1",
    issueId: "i-1",
    status: "open",
    blockerKind: "human",
    steps: [{ round: 1, prompt: "Which synonyms should sofa match in search?", askedAt: "2026-10-21T10:00:00.000Z", answerShape: "free_text", needed: "One per line" }],
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
  };
  const readAt = new Date(2026, 9, 21, 14, 2).getTime();
  const failing = (refetch = vi.fn()) => ({
    data: { questions: [FREE_TEXT] },
    dataUpdatedAt: readAt,
    isLoading: false,
    isError: true,
    error: new TypeError("Failed to fetch"),
    refetch,
  });

  it("keeps the question and what was typed into its box, with a line saying it could not refresh and Retry", () => {
    questionsQuery = { ...found([FREE_TEXT]), dataUpdatedAt: readAt };
    const { rerender } = render(<DecisionPanel issueId="i-1" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "couch\nsettee" } });

    const refetch = vi.fn();
    questionsQuery = failing(refetch);
    rerender(<DecisionPanel issueId="i-1" />);

    expect(screen.getByText("Which synonyms should sofa match in search?")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("couch\nsettee");
    expect(screen.getByText(/^Decisions: Could not refresh — showing what was read at 14:02\./)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();

    questionsQuery = { ...found([FREE_TEXT]), dataUpdatedAt: readAt + 60_000 };
    rerender(<DecisionPanel issueId="i-1" />);
    expect(screen.getByRole("textbox")).toHaveValue("couch\nsettee");
    expect(screen.queryByText(/Could not refresh/)).toBeNull();
  });

  it("offers no Retry where the refresh was refused 401", () => {
    questionsQuery = { ...failing(), error: new ApiError(401, "Your session has ended. Sign in again.", "UNAUTHORIZED") };
    render(<DecisionPanel issueId="i-1" />);
    expect(screen.getByText(/Could not refresh/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
