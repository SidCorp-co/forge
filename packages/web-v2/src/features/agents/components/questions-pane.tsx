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
  useLinkedQuestion,
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
  return question.issueId ? (
    <MonoTag>on an issue</MonoTag>
  ) : (
    <span className="fg-caption text-muted">asked by a master — no issue behind it</span>
  );
}

export function QuestionsPane({ scope, focusQuestionId }: QuestionsPaneProps) {
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useProjectQuestions(scope.projectId);
  const mutation = useAnswerProjectQuestion(scope.projectId);
  const { answering, answer } = useAnsweringQuestions(mutation.mutateAsync);
  const router = useRouter();
  const [answered, setAnswered] = useState<readonly AnsweredCard[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const questions = data?.questions ?? [];
  const focusPresent = !!focusQuestionId && questions.some((q) => q.id === focusQuestionId);
  useEffect(() => {
    if (!focusQuestionId || focusPresent || !hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [focusQuestionId, focusPresent, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const linked = useLinkedQuestion(focusQuestionId ?? undefined, !!focusQuestionId && !focusPresent && !hasNextPage);
  const walkedOut = !!focusQuestionId && !focusPresent && !hasNextPage;
  const questionsRef = useRef<AgentQuestion[]>(questions);
  questionsRef.current = questions;

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

  useEffect(() => {
    if (!focusQuestionId || !focusPresent) return;
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-question-id="${CSS.escape(focusQuestionId)}"]`,
    );
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.querySelector<HTMLElement>("[data-question-title]")?.focus();
  }, [focusQuestionId, focusPresent]);

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
          pending={answering.has(question.id)}
          highlighted={question.id === focusQuestionId}
          context={<IssueContext question={question} />}
        />
      ))}
      {hasNextPage && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading…" : "Load the rest"}
          </button>
          <span className="fg-caption text-muted">
            {questions.length} of {data?.total ?? questions.length} open decisions
          </span>
        </div>
      )}
      {walkedOut && linked.gone && (
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
      {walkedOut && linked.unreachable && (
        <p className="fg-caption text-muted">
          That decision could not be looked up.{" "}
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            onClick={() => void linked.refetch()}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
