// @vitest-environment jsdom


import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentQuestion, VisibleOption } from "../types";
import { QuestionCard } from "./question-card";

expect.extend(matchers);
afterEach(cleanup);

function nth<T>(nodes: ArrayLike<T>, index: number): T {
  const node = nodes[index];
  if (node == null) throw new Error(`expected an element at index ${index}, saw ${nodes.length}`);
  return node;
}

const option = (over: Partial<VisibleOption> = {}): VisibleOption => ({
  id: "opt-a",
  label: "Rewrite the migration",
  authority: "writer",
  bindsTo: "this_call",
  executedBy: "agent",
  locked: false,
  ...over,
});

function question(over: Partial<AgentQuestion> = {}): AgentQuestion {
  const [recommended = option(), ...rest] = over.options ?? [];
  const options = [recommended, ...rest];
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
        prompt: "Round one, already answered",
        options,
        recommendedOptionId: recommended.id,
        askedAt: "2026-09-13T09:00:00.000Z",
        chosenOptionId: recommended.id,
        answeredAt: "2026-09-13T09:05:00.000Z",
      },
      {
        round: 3,
        prompt: "Round three, the one on screen",
        options,
        recommendedOptionId: recommended.id,
        askedAt: "2026-09-13T10:00:00.000Z",
      },
    ],
    options,
    recommendedOptionId: recommended.id,
    answerShape: "choice",
    needed: "",
    locked: false,
    ...over,
  } as AgentQuestion;
}

describe("the decision card", () => {
  it("submits the round it is displaying, not the first one on the row", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={question()} onAnswer={onAnswer} pending={false} />);

    fireEvent.click(screen.getByRole("button", { name: /choose rewrite the migration/i }));

    expect(onAnswer).toHaveBeenCalledWith({ questionId: "q-1", optionId: "opt-a", round: 3 });
  });

  it("renders the live round and submits it when the row carries currentStep instead of steps", () => {
    const onAnswer = vi.fn();
    const full = question();
    const queued = {
      ...full,
      steps: undefined,
      currentStep: full.steps?.[1],
      rounds: 3,
    } as AgentQuestion;
    render(<QuestionCard question={queued} onAnswer={onAnswer} pending={false} />);

    expect(screen.getByText(/Round three, the one on screen/)).toBeInTheDocument();
    expect(screen.getByText(/Round 3/)).toBeInTheDocument();
    expect(screen.getByText(/2 earlier rounds/)).toBeInTheDocument();
    expect(screen.queryByText(/Round one, already answered/)).toBeNull();
    expect(screen.queryByText(/open the issue/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /choose rewrite the migration/i }));
    expect(onAnswer).toHaveBeenCalledWith({ questionId: "q-1", optionId: "opt-a", round: 3 });
  });

  it("names the issue as the way to the earlier rounds when there is one", () => {
    const full = question({ issueId: "i-1" });
    const queued = { ...full, steps: undefined, currentStep: full.steps?.[1], rounds: 3 } as AgentQuestion;
    render(<QuestionCard question={queued} onAnswer={vi.fn()} pending={false} />);

    expect(screen.getByText(/2 earlier rounds — open the issue to read them/i)).toBeInTheDocument();
  });

  it("disables exactly the options the server locked, and leaves them on screen", () => {
    render(
      <QuestionCard
        question={question({
          options: [option(), option({ id: "opt-b", label: "Run it as written", locked: true, authority: "admin" })],
        })}
        onAnswer={vi.fn()}
        pending={false}
      />,
    );

    expect(screen.getByRole("button", { name: /choose rewrite the migration/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /choose run it as written/i })).toBeDisabled();
    expect(screen.getByText(/Needs the "admin" authority/i)).toBeInTheDocument();
  });

  it("marks the first option a person can actually choose, not the first one drawn", () => {
    const { container } = render(
      <QuestionCard
        question={question({
          options: [
            option({ id: "opt-locked", label: "Run it as written", locked: true }),
            option({ id: "opt-open", label: "Rewrite the migration" }),
          ],
        })}
        onAnswer={vi.fn()}
        pending={false}
      />,
    );

    const marked = container.querySelector('[data-first-option="true"]');
    expect(marked).toHaveAccessibleName(/rewrite the migration/i);
    expect(marked).not.toBeDisabled();
  });

  it("marks no option, and offers a focusable title, when every option is locked", () => {
    const { container } = render(
      <QuestionCard
        question={question({ options: [option({ locked: true })] })}
        onAnswer={vi.fn()}
        pending={false}
      />,
    );

    expect(container.querySelector('[data-first-option="true"]')).toBeNull();
    expect(container.querySelector("[data-question-title]")).toHaveAttribute("tabindex", "-1");
  });

  it("shows only the card it was told is pending as pending", () => {
    const { container } = render(
      <>
        <QuestionCard question={question({ id: "q-1" })} onAnswer={vi.fn()} pending />
        <QuestionCard question={question({ id: "q-2" })} onAnswer={vi.fn()} pending={false} />
      </>,
    );

    const cards = container.querySelectorAll("[data-question-id]");
    expect(cards).toHaveLength(2);
    const busy = (el: Element) => el.querySelectorAll("button[disabled], button[aria-busy='true']").length;
    expect(busy(nth(cards, 0)), "the answering card's control is held").toBeGreaterThan(0);
    expect(busy(nth(cards, 1)), "a card nobody is answering stays usable").toBe(0);
  });

  it("keeps a free-text draft after a send that has not landed, and starts a new round clean", () => {
    const free = question({ answerShape: "free_text", options: [], needed: "the staging database name", steps: [
      { round: 3, prompt: "Which database should the backfill run against?", askedAt: "2026-09-13T10:00:00.000Z", answerShape: "free_text", needed: "the staging database name" },
    ] });
    const onAnswer = vi.fn();
    const { rerender } = render(<QuestionCard question={free} onAnswer={onAnswer} pending={false} />);

    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "forge_staging" } });
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    expect(onAnswer).toHaveBeenCalledWith({ questionId: "q-1", text: "forge_staging", round: 3 });
    expect(screen.getByRole("textbox")).toHaveValue("forge_staging");

    const nextRound = question({ answerShape: "free_text", options: [], needed: "the staging database name", steps: [
      { round: 4, prompt: "Which schema inside it?", askedAt: "2026-09-13T10:10:00.000Z", answerShape: "free_text", needed: "the schema" },
    ] });
    rerender(<QuestionCard question={nextRound} onAnswer={onAnswer} pending={false} />);

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("refuses an empty free-text answer without calling the sender", () => {
    const free = question({ answerShape: "free_text", options: [], needed: "the staging database name", steps: [
      { round: 3, prompt: "Which database should the backfill run against?", askedAt: "2026-09-13T10:00:00.000Z", answerShape: "free_text", needed: "the staging database name" },
    ] });
    const onAnswer = vi.fn();
    render(<QuestionCard question={free} onAnswer={onAnswer} pending={false} />);

    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText(/write what the run asked for/i)).toBeInTheDocument();
  });

  it("offers no way to answer a wait no person owns", () => {
    render(
      <QuestionCard question={question({ blockerKind: "machine" })} onAnswer={vi.fn()} pending={false} />,
    );

    expect(screen.queryByRole("button", { name: /choose/i })).toBeNull();
  });

  it("shows the rounds already settled above the one being asked", () => {
    render(<QuestionCard question={question()} onAnswer={vi.fn()} pending={false} />);

    expect(screen.getByText(/Round one, already answered/i)).toBeInTheDocument();
    expect(screen.getByText(/Round three, the one on screen/i)).toBeInTheDocument();
  });
});
