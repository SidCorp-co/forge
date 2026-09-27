"use client";

// The open decisions on this project that name no issue, answerable here.
//
// A question on an issue is the state of that issue: it is answered in the
// issue's `DecisionPanel` and waits on its row in the Issues list, so listing it
// here too made a second queue that could disagree with the first (ISS-1257).
// What stays is the case nothing else can show — a MASTER's question from the
// device door, which carries `issueId: null`.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EmptyState, ErrorState, Skeleton } from "@/design";
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
  scope: { projectId: string; slug: string };
  /** The question a run row linked to, from `?q=`. */
  focusQuestionId?: string | null;
}

/** A run row linked a decision that is on an issue: it is answered there, so say where. */
function OnItsIssue({ slug, issueId }: { slug: string; issueId: string }) {
  return (
    <p className="fg-caption mt-3 text-muted" data-testid="decision-on-issue">
      The decision that run named is on its issue.{" "}
      <Link
        href={`/projects/${slug}/issues/${issueId}`}
        className="underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        Open the issue to answer it
      </Link>
    </p>
  );
}

function IssueContext() {
  return <span className="fg-caption text-muted">asked by a master — no issue behind it</span>;
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
  const onIssue = walkedOut && linked.data?.status === "open" ? linked.data.issueId : null;
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
          title="No master is waiting on a person"
          message="A question a master asks with no issue behind it appears here. A question on an issue waits on that issue's row in the Issues list, and is answered on the issue."
        />
        {onIssue && <OnItsIssue slug={scope.slug} issueId={onIssue} />}
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
          context={<IssueContext />}
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
      {onIssue && <OnItsIssue slug={scope.slug} issueId={onIssue} />}
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
