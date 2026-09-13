// @vitest-environment jsdom

// cm:why the card is tested on its own since ISS-998: it is mounted from two places now — the issue's decision panel and the project queue on the Agents screen — and the two rules that make an irreversible submit safe live in it rather than in either caller. A test per caller would let one caller regress the round guard while the other's suite stayed green.

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
  // cm:guard the ROUND is the whole of the stale-screen protection: core refuses an answer bound to any other, and a caller that pre-bound it would apply a choice made about round 1 to a round 3 nobody read. This asserts the round of the step ON SCREEN, which is why the fixture's first step is a different number — a card submitting `steps[0].round` passes a one-round fixture (ISS-980, ISS-998).
  it("submits the round it is displaying, not the first one on the row", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={question()} onAnswer={onAnswer} pending={false} />);

    fireEvent.click(screen.getByRole("button", { name: /choose rewrite the migration/i }));

    expect(onAnswer).toHaveBeenCalledWith({ questionId: "q-1", optionId: "opt-a", round: 3 });
  });

  // cm:guard `disabled` comes from the SERVER's verdict and from nothing else — this client has no access to the org-derived half of the rule, so a second opinion here is a lock drawn in pixels.
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

  // cm:guard `data-first-option` marks the first ANSWERABLE option and never index zero: it is the target a caller moves focus to, and a locked button takes focus nowhere. The pair is the falsification — a version marking index zero passes the first assertion alone.
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

  // cm:guard a card whose every option is locked marks NO option, because there is nothing on it to focus; the title below is the destination instead, and it is script-focusable for exactly this case.
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

  // cm:guard the pending flag is the card's own, because the project queue renders many of these from ONE mutation: a shared `isPending` puts every card's buttons into a spinner while a single answer is in flight, and the reader cannot tell which decision they are waiting on (ISS-998).
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

  // cm:guard a blocker that resolves without a person gets NO button: asking somebody to settle a machine's wait is a decision that was never theirs (ISS-980 criterion 15).
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
