"use client";

// Every open decision on this project, in one place, answerable here.
//
// Until this pane the only question surface was `DecisionPanel` on an issue's own
// screen, so a question carrying `issueId: null` — which the device door creates
// when a MASTER asks — could be answered nowhere in the product. That is the
// "question nobody receives" this pane exists for, not a second copy of the
// issue panel.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState, ErrorState, MonoTag, Skeleton } from "@/design";
import { QuestionCard } from "@/features/questions/components/question-card";
import {
  useAnsweringQuestions,
  useAnswerProjectQuestion,
  useProjectQuestions,
} from "@/features/questions/hooks";
import type { AgentQuestion, AnswerInput } from "@/features/questions/types";
import { formatApiError } from "@/lib/api/error";

const EMPTY_TITLE_ID = "agents-questions-empty-title";

interface AnsweredCard {
  id: string;
  /** Where the card sat, so focus lands on the one that takes its place. */
  index: number;
}

export interface QuestionsPaneProps {
  scope: { projectId: string };
  /** The question a run row linked to, from `?q=`. */
  focusQuestionId?: string | null;
}

function IssueContext({ question }: { question: AgentQuestion }) {
  // cm:guard a question with NO issue says so in words rather than rendering an empty slot: that is the shape a master's question takes, it is the one this pane was built for, and a blank there reads as a rendering fault rather than as a fact about the question.
  return question.issueId ? (
    <MonoTag>on an issue</MonoTag>
  ) : (
    <span className="fg-caption text-muted">asked by a master — no issue behind it</span>
  );
}

export function QuestionsPane({ scope, focusQuestionId }: QuestionsPaneProps) {
  const { data, isLoading, isError, error, refetch } = useProjectQuestions(scope.projectId);
  const mutation = useAnswerProjectQuestion(scope.projectId);
  const { answering, answer } = useAnsweringQuestions(mutation.mutateAsync);
  const router = useRouter();
  const [answered, setAnswered] = useState<readonly AnsweredCard[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const questions = data?.questions ?? [];
  const focusPresent = !!focusQuestionId && questions.some((q) => q.id === focusQuestionId);
  const questionsRef = useRef<AgentQuestion[]>(questions);
  questionsRef.current = questions;

  // cm:guard focus is moved only after the answered card has actually LEFT the list, which is why this watches the data rather than the mutation's success: the card is removed when the refetch lands, and focusing before that puts the reader back on a control that is about to be unmounted, which drops focus to the document body — the exact thing a keyboard reader cannot recover from (ISS-998).
  // cm:guard the destination is the card that took the answered one's PLACE, not the first card in the list: answering the middle of three otherwise throws the reader back to the top, past a decision they have already read and past the one that followed the one they just made (ISS-998).
  // cm:guard the fallbacks are three deep because each can be absent: the replacing card's first answerable option, then that card's title where every option on it is server-locked, then the empty-state heading where no card is left. One lookup that misses lands the reader on the document body.
  useEffect(() => {
    if (isLoading || answered.length === 0) return;
    const head = answered[0];
    if (!head) return;
    if (questions.some((q) => q.id === head.id)) return;
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [];
    const card = cards[Math.min(head.index, cards.length - 1)];
    const target =
      card?.querySelector<HTMLElement>('[data-first-option="true"]') ??
      card?.querySelector<HTMLElement>("[data-question-title]");
    (target ?? document.getElementById(EMPTY_TITLE_ID))?.focus();
    setAnswered((rest) => rest.slice(1));
  }, [answered, isLoading, questions]);

  // cm:guard a link naming a question must put the reader ON that card, not on a tab holding it: the named card can be below the fold, and a shadow says nothing to somebody who is not looking at pixels. The dependency is the card's PRESENCE rather than the list, so a question that arrives on the 30s poll — the list was cached without it when the link opened — is still reached, and a refetch that changes nothing does not steal focus back (ISS-998).
  useEffect(() => {
    if (!focusQuestionId || !focusPresent) return;
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-question-id="${CSS.escape(focusQuestionId)}"]`,
    );
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.querySelector<HTMLElement>("[data-question-title]")?.focus();
  }, [focusQuestionId, focusPresent]);

  // cm:guard the index is captured at SEND time, from the list as it stood when the reader chose: by the time the answer settles the card is gone and its place is the only thing left to aim focus at (ISS-998).
  const onAnswer = useCallback(
    (input: AnswerInput) => {
      const index = Math.max(
        0,
        questionsRef.current.findIndex((q) => q.id === input.questionId),
      );
      answer(input, () => setAnswered((rest) => [...rest, { id: input.questionId, index }]));
    },
    [answer],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4" aria-busy="true">
        {[0, 1].map((i) => (
          <Skeleton key={i} variant="rect" className="h-40 w-full" />
        ))}
      </div>
    );
  }

  // cm:guard a failed read and an empty queue are two different screens. Collapsed into one, a decision somebody owes disappears behind "nothing is waiting" with nothing to retry (project ux-contract §2).
  if (isError) {
    return (
      <div className="grid min-h-[40vh] place-items-center p-4">
        <ErrorState
          title="Couldn't load this project's decisions"
          message={formatApiError(error)}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="grid min-h-[40vh] place-items-center p-4">
        <EmptyState
          titleId={EMPTY_TITLE_ID}
          title="Nothing is waiting on a person"
          message="A decision an agent parks on a human appears here, whether or not it names an issue."
        />
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex flex-col gap-3 p-4">
      {questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          onAnswer={onAnswer}
          // cm:guard pending is scoped to the question in flight; one flag across the list would spin every card's buttons while a single answer was being sent (ISS-998).
          pending={answering.has(question.id)}
          highlighted={question.id === focusQuestionId}
          context={<IssueContext question={question} />}
        />
      ))}
      {focusQuestionId && !questions.some((q) => q.id === focusQuestionId) && (
        // cm:guard a link that arrives naming a question no longer open says SO, rather than dropping the reader into a list they cannot tell apart: the run that sent them here is still parked, and silence would read as "the question was here somewhere".
        <p className="fg-caption text-muted">
          The decision that run named is no longer open.{" "}
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            onClick={() => router.refresh()}
          >
            Refresh
          </button>
        </p>
      )}
    </div>
  );
}
