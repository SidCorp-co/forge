// @vitest-environment jsdom
//
// Per-file jsdom opt-in: web-v2's vitest config stays `environment: 'node'`
// globally and matchers are extended on vitest's OWN `expect` — see the
// docblock on project-dashboard/awaiting-release-card.test.tsx for why.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentQuestion, QuestionStep, VisibleOption } from "../types";
import { DecisionPanel } from "./decision-panel";

expect.extend(matchers);

const list = vi.fn();
const mutate = vi.fn();
vi.mock("../hooks", () => ({
  useIssueQuestions: () => list(),
  useAnswerQuestion: () => ({ mutate, isPending: false }),
}));

const SAFE: VisibleOption = {
  id: "opt-safe",
  label: "Take the safe path",
  authority: "writer",
  bindsTo: "session",
  executedBy: "agent",
  locked: false,
};
const DEPLOY: VisibleOption = {
  id: "opt-deploy",
  label: "Deploy it",
  authority: "admin",
  bindsTo: "project",
  executedBy: "human",
  locked: true,
};

function step(over: Partial<QuestionStep> = {}): QuestionStep {
  return {
    round: 1,
    prompt: "Push to a shared branch?",
    options: [SAFE, DEPLOY],
    recommendedOptionId: SAFE.id,
    askedAt: "2026-09-11T09:00:00.000Z",
    ...over,
  };
}

function aQuestion(over: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id: "q-1",
    projectId: "p-1",
    issueId: "i-1",
    status: "open",
    blockerKind: "human",
    steps: [step()],
    maxRounds: 3,
    voidReason: null,
    endedReason: null,
    parkDeadlineAt: null,
    createdAt: "2026-09-11T09:00:00.000Z",
    updatedAt: "2026-09-11T09:00:00.000Z",
    options: [SAFE, DEPLOY],
    recommendedOptionId: SAFE.id,
    ...over,
  };
}

function loaded(questions: AgentQuestion[]) {
  list.mockReturnValue({
    data: { questions },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
}

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DecisionPanel issueId="i-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  list.mockReset();
  mutate.mockReset();
});
afterEach(cleanup);

describe("the open round a person is being asked about", () => {
  it("renders the prompt of the round the question is on", () => {
    loaded([aQuestion()]);
    renderPanel();
    expect(screen.getByText("Push to a shared branch?")).toBeInTheDocument();
  });

  it("marks the recommended option and only that one", () => {
    loaded([aQuestion()]);
    renderPanel();
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
  });

  // cm:guard the three attributes are asserted as the WORDS a reader acts on, not as the stored values: `bindsTo: 'session'` on screen tells a person nothing about what they are agreeing to (ISS-980 criteria 3, 4, 5).
  it("says what each of an option's three attributes means for the reader", () => {
    loaded([aQuestion()]);
    renderPanel();

    expect(screen.getByText("Any project member can choose this")).toBeInTheDocument();
    expect(screen.getByText("Only a project admin can choose this")).toBeInTheDocument();
    expect(screen.getByText("Applies for the rest of this session")).toBeInTheDocument();
    expect(screen.getByText("Applies to this project from now on")).toBeInTheDocument();
    expect(screen.getByText("The agent carries this out")).toBeInTheDocument();
    expect(screen.getByText("You carry this out")).toBeInTheDocument();
  });

  it("renders every round of a question that took three", () => {
    const three = aQuestion({
      steps: [
        step({ round: 1, prompt: "Round one?", chosenOptionId: SAFE.id }),
        step({ round: 2, prompt: "Round two?", chosenOptionId: SAFE.id }),
        step({ round: 3, prompt: "Round three?" }),
      ],
    });
    loaded([three]);
    renderPanel();

    expect(screen.getByText("Round one?")).toBeInTheDocument();
    expect(screen.getByText("Round two?")).toBeInTheDocument();
    expect(screen.getByText("Round three?")).toBeInTheDocument();
  });

  it("answers with the option and the round it was shown on", () => {
    loaded([aQuestion({ steps: [step({ round: 2 })] })]);
    renderPanel();

    fireEvent.click(screen.getAllByRole("button", { name: /^Choose / })[0] as HTMLElement);

    expect(mutate).toHaveBeenCalledWith({
      questionId: "q-1",
      optionId: SAFE.id,
      round: 2,
    });
  });
});

describe("a lock is the server's verdict and the screen renders it", () => {
  it("keeps a locked option on screen and refuses to activate it", () => {
    loaded([aQuestion()]);
    renderPanel();

    expect(
      screen.getByText("Deploy it"),
      "hiding an option leaves a queue of decisions only one person can even look at",
    ).toBeInTheDocument();
    const [safe, deploy] = screen.getAllByRole("button", { name: /^Choose / });
    expect(safe).not.toBeDisabled();
    expect(deploy).toBeDisabled();
  });

  it("names the authority a locked option requires", () => {
    loaded([aQuestion()]);
    renderPanel();
    expect(screen.getByText('Needs the "admin" authority')).toBeInTheDocument();
  });

  // cm:guard the SAME role, the same options, only `locked` moved — which is what proves the screen renders the server's verdict rather than re-deriving one of its own (ISS-980 criterion 8).
  it("follows the flag and nothing else", () => {
    loaded([aQuestion({ options: [{ ...SAFE, locked: true }, { ...DEPLOY, locked: false }] })]);
    renderPanel();

    const [safe, deploy] = screen.getAllByRole("button", { name: /^Choose / });
    expect(safe).toBeDisabled();
    expect(deploy).not.toBeDisabled();
  });
});

describe("a question nobody is being asked to answer", () => {
  it.each([
    ["machine", "machine"],
    ["master_or_peer", "master_or_peer"],
  ] as const)("offers no control on a %s blocker", (_name, blockerKind) => {
    loaded([aQuestion({ blockerKind })]);
    renderPanel();

    expect(screen.getByText("Push to a shared branch?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Choose / })).toBeNull();
  });

  it("shows what was chosen on an answered question and offers no form", () => {
    loaded([
      aQuestion({ status: "answered", steps: [step({ chosenOptionId: DEPLOY.id })] }),
    ]);
    renderPanel();

    expect(screen.getByText("Answered — Deploy it")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Choose / })).toBeNull();
  });

  it("shows why a voided question was withdrawn and offers no form", () => {
    loaded([aQuestion({ status: "void", voidReason: "the branch is gone" })]);
    renderPanel();

    expect(screen.getByText("Withdrawn — the branch is gone")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Choose / })).toBeNull();
  });

  it("says an expired question went unanswered and offers no form", () => {
    loaded([aQuestion({ status: "expired", endedReason: "unanswered_2d" })]);
    renderPanel();

    expect(screen.getByText("Expired unanswered — unanswered_2d")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Choose / })).toBeNull();
  });
});

describe("nothing, loading and broken are three different screens", () => {
  it("renders nothing at all for an issue with no question", () => {
    loaded([]);
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a loading state rather than the empty one while the read is in flight", () => {
    list.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container } = renderPanel();
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: /^Choose / })).toBeNull();
  });

  // cm:guard a failed read rendered as the empty state makes a decision somebody owes VANISH from the screen, indistinguishable from an issue that never had one — and the reader is never told to try again (ISS-980 criterion 17).
  it("renders a recoverable error when the read fails", () => {
    const refetch = vi.fn();
    list.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("network down"),
      refetch,
    });
    const { container } = renderPanel();

    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText("network down")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
