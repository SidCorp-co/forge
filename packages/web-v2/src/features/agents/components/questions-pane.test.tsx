// @vitest-environment jsdom


import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { linkedVerdict } from "@/features/questions/hooks";
import type { AgentQuestion, AnswerInput } from "@/features/questions/types";

expect.extend(matchers);
afterEach(cleanup);

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

let list: {
  data?: { questions: AgentQuestion[]; total?: number; hasMore?: boolean };
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
};
const fetchNextPage = vi.fn();
/** The authoritative single-question read the pane checks before concluding a linked decision is gone. */
let linked: { isError: boolean; isSuccess: boolean; error?: unknown; data?: { status: string } };
const linkedRefetch = vi.fn();
const refetch = vi.fn();
const mutate = vi.fn();
/** Each call's resolver, so a test can settle one answer while another is still in flight. */
let settle: Array<{ resolve: () => void; reject: (e: unknown) => void; input: AnswerInput }> = [];
const mutateAsync = vi.fn((input: AnswerInput) => {
  mutate(input);
  return new Promise<void>((resolve, reject) => {
    settle.push({ resolve, reject, input });
  });
});

vi.mock("@/features/questions/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/questions/hooks")>()),
  useProjectQuestions: () => ({ ...list, refetch, fetchNextPage }),
  useLinkedQuestion: () => ({ ...linked, refetch: linkedRefetch, ...linkedVerdict(linked) }),
  useAnswerProjectQuestion: () => ({ mutate, mutateAsync }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { QuestionsPane } = await import("./questions-pane");

const scope = { projectId: "p-1" };

function nth<T>(nodes: ArrayLike<T>, index: number): T {
  const node = nodes[index];
  if (node == null) throw new Error(`expected an element at index ${index}, saw ${nodes.length}`);
  return node;
}

const onlyOption = () => ({
  id: "opt-a",
  label: "Dispatch the staging deploy",
  authority: "writer" as const,
  bindsTo: "this_call" as const,
  executedBy: "agent" as const,
  locked: false,
});

function withOptions(
  q: AgentQuestion,
  options: ReturnType<typeof onlyOption>[],
): AgentQuestion {
  return {
    ...q,
    options,
    steps: (q.steps ?? []).map((step) => ({ ...step, options })),
  } as AgentQuestion;
}

function question(over: Partial<AgentQuestion> = {}): AgentQuestion {
  const options = [
    {
      id: "opt-a",
      label: "Dispatch the staging deploy",
      authority: "writer" as const,
      bindsTo: "this_call" as const,
      executedBy: "agent" as const,
      locked: false,
    },
  ];
  return {
    id: "q-1",
    projectId: "p-1",
    issueId: null,
    status: "open",
    blockerKind: "human",
    maxRounds: 3,
    voidReason: null,
    endedReason: null,
    parkDeadlineAt: null,
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    steps: [
      {
        round: 1,
        prompt: "Dispatch the staging deploy now?",
        options,
        recommendedOptionId: "opt-a",
        askedAt: "2026-09-13T10:00:00.000Z",
      },
    ],
    options,
    recommendedOptionId: "opt-a",
    answerShape: "choice",
    needed: "",
    locked: false,
    ...over,
  } as AgentQuestion;
}

beforeEach(() => {
  list = { isLoading: false, isError: false, data: { questions: [] } };
  linked = { isError: true, isSuccess: false, error: new ApiError(404, "not found") };
  refetch.mockClear();
  fetchNextPage.mockClear();
  mutate.mockClear();
  mutateAsync.mockClear();
  settle = [];
});

describe("the project's open decisions", () => {
  it("shows a loading placeholder rather than an empty screen", () => {
    list = { isLoading: true, isError: false };
    const { container } = render(<QuestionsPane scope={scope} />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("tells a failed read apart from an empty queue, and offers the retry", () => {
    list = { isLoading: false, isError: true, error: new Error("nope") };
    render(<QuestionsPane scope={scope} />);

    expect(screen.queryByText(/Nothing is waiting on a person/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("tells a project with no open decision that one will appear here", () => {
    render(<QuestionsPane scope={scope} />);

    expect(screen.getByText(/Nothing is waiting on a person/i)).toBeInTheDocument();
  });

  it("answers a question that names no issue at all", () => {
    list = { isLoading: false, isError: false, data: { questions: [question({ issueId: null })] } };
    render(<QuestionsPane scope={scope} />);

    expect(screen.getByText(/asked by a master — no issue behind it/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /choose dispatch the staging deploy/i }));
    expect(mutate).toHaveBeenCalledWith({ questionId: "q-1", optionId: "opt-a", round: 1 });
  });

  it("says how many open decisions are not on screen, and fetches the rest on request", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 63, hasMore: true },
      hasNextPage: true,
    };
    render(<QuestionsPane scope={scope} />);

    expect(screen.getByText(/1 of 63 open decisions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /load the rest/i }));
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it("offers no load control when the first page is the whole queue", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 1, hasMore: false },
      hasNextPage: false,
    };
    render(<QuestionsPane scope={scope} />);

    expect(screen.queryByRole("button", { name: /load the rest/i })).toBeNull();
    expect(screen.queryByText(/open decisions/i)).toBeNull();
  });

  it("walks to a later page for a linked question rather than calling it closed", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 60, hasMore: true },
      hasNextPage: true,
    };
    render(<QuestionsPane scope={scope} focusQuestionId="q-59" />);

    expect(screen.queryByText(/no longer open/i)).toBeNull();
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it("says a linked question is gone only once every page has been read and the question itself refused", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 1, hasMore: false },
      hasNextPage: false,
    };
    linked = { isError: true, isSuccess: false, error: new ApiError(404, "not found") };
    render(<QuestionsPane scope={scope} focusQuestionId="q-59" />);

    expect(screen.getByText(/no longer open/i)).toBeInTheDocument();
  });

  it("does not call a linked question gone when its own read merely failed", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 1, hasMore: false },
      hasNextPage: false,
    };
    linked = { isError: true, isSuccess: false, error: new ApiError(500, "upstream is down") };
    render(<QuestionsPane scope={scope} focusQuestionId="q-59" />);

    expect(screen.queryByText(/no longer open/i)).toBeNull();
    expect(screen.getByText(/could not be looked up/i)).toBeInTheDocument();
  });

  it("offers to retry the lookup rather than the page when it could not be reached", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 1, hasMore: false },
      hasNextPage: false,
    };
    linked = { isError: true, isSuccess: false, error: new TypeError("Failed to fetch") };
    render(<QuestionsPane scope={scope} focusQuestionId="q-59" />);

    expect(screen.queryByText(/no longer open/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(linkedRefetch).toHaveBeenCalled();
  });

  it("calls a linked question gone when its own read comes back answered", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 1, hasMore: false },
      hasNextPage: false,
    };
    linked = { isError: false, isSuccess: true, data: { status: "answered" } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-59" />);

    expect(screen.getByText(/no longer open/i)).toBeInTheDocument();
  });

  it("does not call a linked question gone when the question itself is still open", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" })], total: 1, hasMore: false },
      hasNextPage: false,
    };
    linked = { isError: false, isSuccess: true, data: { status: "open" } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-59" />);

    expect(screen.queryByText(/no longer open/i)).toBeNull();
  });

  it("marks the card a run row linked to, among several", () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), question({ id: "q-2" })] },
    };
    const { container } = render(<QuestionsPane scope={scope} focusQuestionId="q-2" />);

    const cards = container.querySelectorAll("[data-question-id]");
    expect(nth(cards, 0).className).not.toContain("shadow-[var(--shadow-focus)]");
    expect(nth(cards, 1).className).toContain("shadow-[var(--shadow-focus)]");
  });

  it("answers a question asked in words, not only one with options", async () => {
    const inWords = {
      ...question({ id: "q-text" }),
      answerShape: "free_text",
      options: [],
      needed: "the staging database name",
    } as unknown as AgentQuestion;
    list = { isLoading: false, isError: false, data: { questions: [inWords] } };
    render(<QuestionsPane scope={scope} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "forge_beta" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    });

    expect(mutate).toHaveBeenCalledWith({ questionId: "q-text", text: "forge_beta", round: 1 });
  });

  it("refuses an empty answer rather than spending a round on it", async () => {
    const inWords = {
      ...question({ id: "q-text" }),
      answerShape: "free_text",
      options: [],
      needed: "the staging database name",
    } as unknown as AgentQuestion;
    list = { isLoading: false, isError: false, data: { questions: [inWords] } };
    render(<QuestionsPane scope={scope} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/write what the run asked for/i)).toBeInTheDocument();
  });

  it("holds each card on its own answer while two are in flight", async () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), question({ id: "q-2" })] },
    };
    render(<QuestionsPane scope={scope} />);

    const buttons = () => screen.getAllByRole("button", { name: /choose dispatch/i });
    await act(async () => {
      fireEvent.click(nth(buttons(), 0));
    });
    await act(async () => {
      fireEvent.click(nth(buttons(), 1));
    });

    expect(nth(buttons(), 0)).toBeDisabled();
    expect(nth(buttons(), 1)).toBeDisabled();

    await act(async () => settle[0]?.resolve());

    expect(nth(buttons(), 1)).toBeDisabled();
  });

  it("moves focus to the card that takes the answered one's place, not to the top", async () => {
    list = {
      isLoading: false,
      isError: false,
      data: {
        questions: [question({ id: "q-1" }), question({ id: "q-2" }), question({ id: "q-3" })],
      },
    };
    const view = render(<QuestionsPane scope={scope} />);

    fireEvent.click(nth(screen.getAllByRole("button", { name: /choose dispatch/i }), 1));
    await act(async () => settle[0]?.resolve());
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), question({ id: "q-3" })] },
    };
    view.rerender(<QuestionsPane scope={scope} />);

    const q3 = view.container.querySelector('[data-question-id="q-3"]');
    expect(document.activeElement).toBe(q3?.querySelector('[data-first-option="true"]'));
  });

  it("reaches the linked card when it arrives on a later read", async () => {
    list = { isLoading: false, isError: false, data: { questions: [question({ id: "q-1" })] } };
    const view = render(<QuestionsPane scope={scope} focusQuestionId="q-2" />);
    expect(screen.getByText(/no longer open/i)).toBeInTheDocument();

    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), question({ id: "q-2" })] },
    };
    view.rerender(<QuestionsPane scope={scope} focusQuestionId="q-2" />);

    const q2 = view.container.querySelector('[data-question-id="q-2"]');
    expect(document.activeElement).toBe(q2?.querySelector("[data-question-title]"));
  });

  it("says so when the question a row linked to is no longer open", () => {
    list = { isLoading: false, isError: false, data: { questions: [question({ id: "q-1" })] } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-gone" />);

    expect(screen.getByText(/no longer open/i)).toBeInTheDocument();
  });

  it("skips a locked option when it moves focus to the next decision", async () => {
    const locked = [
      { ...onlyOption(), id: "opt-locked", label: "Run it as written", locked: true },
      { ...onlyOption(), id: "opt-open", label: "Rewrite the migration" },
    ];
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), withOptions(question({ id: "q-2" }), locked)] },
    };
    const view = render(<QuestionsPane scope={scope} />);

    fireEvent.click(nth(screen.getAllByRole("button", { name: /choose dispatch/i }), 0));
    await act(async () => settle[0]?.resolve());
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [withOptions(question({ id: "q-2" }), locked)] },
    };
    view.rerender(<QuestionsPane scope={scope} />);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /choose rewrite the migration/i }),
    );
  });

  it("puts focus in the answer box when the next decision is asked in words", async () => {
    const inWords = {
      ...question({ id: "q-text" }),
      answerShape: "free_text",
      options: [],
      needed: "the staging database name",
    } as unknown as AgentQuestion;
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), inWords] },
    };
    const view = render(<QuestionsPane scope={scope} />);

    fireEvent.click(nth(screen.getAllByRole("button", { name: /choose dispatch/i }), 0));
    await act(async () => settle[0]?.resolve());
    list = { isLoading: false, isError: false, data: { questions: [inWords] } };
    view.rerender(<QuestionsPane scope={scope} />);

    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("falls back to the next card's title when every option on it is locked", async () => {
    const allLocked = [{ ...onlyOption(), id: "opt-locked", locked: true }];
    list = {
      isLoading: false,
      isError: false,
      data: {
        questions: [question({ id: "q-1" }), withOptions(question({ id: "q-2" }), allLocked)],
      },
    };
    const view = render(<QuestionsPane scope={scope} />);

    fireEvent.click(nth(screen.getAllByRole("button", { name: /choose dispatch/i }), 0));
    await act(async () => settle[0]?.resolve());
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [withOptions(question({ id: "q-2" }), allLocked)] },
    };
    view.rerender(<QuestionsPane scope={scope} />);

    expect(document.activeElement).toBe(
      nth(view.container.querySelectorAll("[data-question-title]"), 0),
    );
  });

  it("focuses and scrolls to the card a run row linked to", () => {
    const scrolled: Element[] = [];
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function scroll(this: Element) {
        scrolled.push(this);
      });
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), question({ id: "q-2" })] },
    };
    const { container } = render(<QuestionsPane scope={scope} focusQuestionId="q-2" />);

    const card = container.querySelector('[data-question-id="q-2"]');
    expect(scrolled).toEqual([card]);
    expect(document.activeElement).toBe(card?.querySelector("[data-question-title]"));
    spy.mockRestore();
  });

  it("puts focus on the next decision once the answered one is gone", async () => {
    list = {
      isLoading: false,
      isError: false,
      data: { questions: [question({ id: "q-1" }), question({ id: "q-2" })] },
    };
    const view = render(<QuestionsPane scope={scope} />);

    fireEvent.click(nth(screen.getAllByRole("button", { name: /choose dispatch/i }), 0));
    await act(async () => settle[0]?.resolve());
    list = { isLoading: false, isError: false, data: { questions: [question({ id: "q-2" })] } };
    view.rerender(<QuestionsPane scope={scope} />);

    expect(document.activeElement).toBe(
      view.container.querySelector('[data-first-option="true"]'),
    );
  });

  it("puts focus on the empty state once the last decision is gone", async () => {
    list = { isLoading: false, isError: false, data: { questions: [question({ id: "q-1" })] } };
    const view = render(<QuestionsPane scope={scope} />);

    fireEvent.click(screen.getByRole("button", { name: /choose dispatch/i }));
    await act(async () => settle[0]?.resolve());
    list = { isLoading: false, isError: false, data: { questions: [] } };
    view.rerender(<QuestionsPane scope={scope} />);

    expect(document.activeElement).toBe(
      screen.getByText(/Nothing is waiting on a person/i),
    );
  });
});
