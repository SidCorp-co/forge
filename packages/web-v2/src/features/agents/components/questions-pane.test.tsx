// @vitest-environment jsdom

// cm:why this pane is asserted rather than eyeballed: the case it exists for — a question carrying no issue, which a MASTER asks — is answerable nowhere else in the product, and it is invisible in any fixture built from an issue. The four render branches and the focus move are the ux-contract items a screenshot cannot hold still (ISS-998).

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentQuestion, AnswerInput } from "@/features/questions/types";

expect.extend(matchers);
afterEach(cleanup);

// cm:why jsdom defines no `scrollIntoView` on Element at all, so it is installed here rather than called optionally in the pane: `card.scrollIntoView?.()` would also swallow a real browser's missing scroll, and this assertion is the only thing that holds the deep link on the card.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

let list: {
  data?: { questions: AgentQuestion[] };
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};
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

// cm:guard `useAnsweringQuestions` is the REAL one and only the two fetch hooks are replaced: holding each card on its own answer is what this file asserts, and a stub of it would assert the stub.
vi.mock("@/features/questions/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/questions/hooks")>()),
  useProjectQuestions: () => ({ ...list, refetch }),
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
    steps: q.steps.map((step) => ({ ...step, options })),
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
  refetch.mockClear();
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

  // cm:guard a failed read and an empty queue are two DIFFERENT screens. Collapsed into one, a decision somebody owes disappears behind "nothing is waiting" with nothing to retry (ux-contract §2).
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

  // cm:guard THE case this pane was built for: `askQuestion` on the device door takes a projectId and no issue, so a master's question has no issue screen to be answered from. A pane that only rendered issue-bearing questions would pass every other test here and leave that one unanswerable.
  it("answers a question that names no issue at all", () => {
    list = { isLoading: false, isError: false, data: { questions: [question({ issueId: null })] } };
    render(<QuestionsPane scope={scope} />);

    expect(screen.getByText(/asked by a master — no issue behind it/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /choose dispatch the staging deploy/i }));
    expect(mutate).toHaveBeenCalledWith({ questionId: "q-1", optionId: "opt-a", round: 1 });
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

  // cm:guard the queue answers a FREE-TEXT round too, which is the lane ISS-996 added while this pane was being built: a question a master asks in words has no issue screen to be answered from either, so a queue that only rendered choices would leave exactly those unanswerable — the case this pane exists for, in its other shape (ISS-996, ISS-998).
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

  // cm:guard an empty answer is refused on the queue exactly as it is on the issue panel, because the card owns that rule: a blank body reaches core as a real answer and spends a round saying nothing.
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

  // cm:guard TWO answers may be in flight at once, and each card's control is held on its OWN answer: react-query keeps a single `variables` slot, so a version reading it offered the first card's irreversible button again the moment the second was submitted. The pair is the falsification — a build holding every card passes the first assertion alone.
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

  // cm:guard focus lands on the card that took the answered one's PLACE, not on the first card in the list: answering the middle of three otherwise throws the reader back above a decision they have already read. The fixture is three cards for exactly that reason — a two-card list cannot tell the two behaviours apart.
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

  // cm:guard the link's card is reached when it arrives LATE — the list was cached without it when the link opened and the 30s poll brought it in. An effect keyed on the link and the loading flag alone never re-runs for that, and the reader is left on a tab they cannot navigate.
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

  // cm:guard a link arriving on a decision that has since been answered says so: the run that sent the reader here is still parked, and silence reads as "it was here somewhere".
  it("says so when the question a row linked to is no longer open", () => {
    list = { isLoading: false, isError: false, data: { questions: [question({ id: "q-1" })] } };
    render(<QuestionsPane scope={scope} focusQuestionId="q-gone" />);

    expect(screen.getByText(/no longer open/i)).toBeInTheDocument();
  });

  // cm:guard the destination is the first ANSWERABLE option, not the first one drawn: a locked button takes focus nowhere, so a version reading index zero drops the keyboard reader onto the document body while looking correct on every unlocked fixture (ISS-998).
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

  // cm:guard the last resort when a remaining card has NO answerable option at all: the card's own title, which is why it is script-focusable. Without it this reader lands on the body with a decision still on screen (ISS-998).
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

  // cm:guard a link puts the reader ON the card, not on the tab holding it: a shadow says nothing to somebody not looking at pixels, and the named card can be below the fold. The assertion pairs focus with the scroll, because either alone leaves one of the two readers behind.
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

  // cm:guard focus is moved only once the answered card has LEFT the list, not on the mutation's success: the card unmounts when the refetch lands, and focusing before that drops the keyboard reader onto the document body with nothing to go back to.
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
