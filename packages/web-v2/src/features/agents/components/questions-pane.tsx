
// The open decisions on this project that name no issue, answerable here.
//
// A question on an issue is the state of that issue: it is answered in the
// issue's `DecisionPanel` and waits on its row in the Issues list, so listing it
// here too made a second queue that could disagree with the first (ISS-1257).
// What stays is the case nothing else can show — a MASTER's question from the
// device door, which carries `issueId: null`.

import { useEffect, useRef } from "react";
import { useRouter } from "@/lib/navigation/router";
import { EmptyState, ErrorState, Skeleton } from "@/design";
import { QuestionView } from "@/features/questions";
import {
  useAnsweringQuestions,
  useAnswerProjectQuestion,
  useLinkedQuestion,
  useProjectQuestions,
} from "@/features/questions";
import type { AgentQuestion, AnswerInput } from "@/features/questions";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";

const EMPTY_TITLE_ID = "agents-questions-empty-title";
const NO_QUESTIONS: AgentQuestion[] = [];

interface AnsweredCard {
  id: string;
  /** Where the card sat, so focus lands on the one that takes its place. */
  index: number;
}

interface QuestionsPaneProps {
  scope: { projectId: string; slug: string };
  /** The question a run row linked to, from `?q=`. */
  focusQuestionId?: string | null;
}

function IssueContext() {
  const t = useCopy();
  return <span className="fg-caption text-muted">{t("agents.questions.byMaster")}</span>;
}

export function QuestionsPane({ scope, focusQuestionId }: QuestionsPaneProps) {
  const t = useCopy();
  const time = useTimeFormat();
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useProjectQuestions(scope.projectId);
  const mutation = useAnswerProjectQuestion(scope.projectId);
  const { answering, answer } = useAnsweringQuestions(mutation.mutateAsync);
  const router = useRouter();
  // Answered cards waiting to hand focus on once core drops them from the list.
  const answeredRef = useRef<AnsweredCard[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const questions = data?.questions ?? NO_QUESTIONS;
  const focusPresent = !!focusQuestionId && questions.some((q) => q.id === focusQuestionId);
  // A question on an issue is never on this list, so the one a run row linked is looked up
  // at once: if it names an issue, answered or not, that issue is where the link goes.
  const linked = useLinkedQuestion(focusQuestionId ?? undefined, !!focusQuestionId && !focusPresent);
  const walkedOut = !!focusQuestionId && !focusPresent && !hasNextPage;
  const onIssue = linked.query.data?.issueId ?? null;
  useEffect(() => {
    if (!focusQuestionId || focusPresent || onIssue || !hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [focusQuestionId, focusPresent, onIssue, hasNextPage, isFetchingNextPage, fetchNextPage]);
  useEffect(() => {
    if (onIssue) router.replace(`/projects/${scope.slug}/issues/${onIssue}`);
  }, [onIssue, router, scope.slug]);
  // The answered card has left the list: focus lands on the card now in its place, or the empty title.
  const handFocusOn = (current: readonly AgentQuestion[]) => {
    const head = answeredRef.current[0];
    if (!head || current.some((q) => q.id === head.id)) return;
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [];
    const card = cards[Math.min(head.index, cards.length - 1)];
    const target =
      card?.querySelector<HTMLElement>('[data-first-option="true"]') ??
      card?.querySelector<HTMLElement>("[data-question-title]");
    (target ?? document.getElementById(EMPTY_TITLE_ID))?.focus();
    answeredRef.current = answeredRef.current.slice(1);
  };
  useEffect(() => {
    if (!isLoading) handFocusOn(questions);
  });

  useEffect(() => {
    if (!focusQuestionId || !focusPresent) return;
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-question-id="${CSS.escape(focusQuestionId)}"]`,
    );
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.querySelector<HTMLElement>("[data-question-title]")?.focus();
  }, [focusQuestionId, focusPresent]);

  const onAnswer = (input: AnswerInput) => {
      const index = Math.max(
        0,
        questions.findIndex((q) => q.id === input.questionId),
      );
      answer(input, () => {
        answeredRef.current = [...answeredRef.current, { id: input.questionId, index }];
      });
    };

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
      <div className="grid min-h-80 place-items-center p-4">
        <ErrorState
          title={t("agents.questions.loadFailed")}
          message={formatApiError(error)}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  if (onIssue) {
    return (
      <p className="fg-caption p-4 text-muted" role="status" data-testid="decision-on-issue">
        {t("agents.questions.onIssue")}
      </p>
    );
  }

  if (questions.length === 0) {
    return (
      <div id={EMPTY_TITLE_ID} tabIndex={-1} className="grid min-h-80 place-items-center p-4 focus-visible:outline-none">
        <EmptyState message={t("agents.questions.emptyTitle")} />
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex flex-col gap-3 p-4">
      {questions.map((question) => (
        <QuestionView
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
            className="underline focus-visible:outline-none focus-visible:shadow-focus"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? t("agents.questions.loading") : t("agents.questions.loadRest")}
          </button>
          <span className="fg-caption text-muted">
            {t("agents.questions.openOf", { n: time.number(questions.length), total: time.number(data?.total ?? questions.length) })}
          </span>
        </div>
      )}
      {walkedOut && !onIssue && linked.gone && (
        <p className="fg-caption text-muted">
          {t("agents.questions.gone")}{" "}
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:shadow-focus"
            onClick={() => router.refresh()}
          >
            {t("agents.questions.refresh")}
          </button>
        </p>
      )}
      {walkedOut && !onIssue && linked.unreachable && (
        <p className="fg-caption text-muted">
          {t("agents.questions.unreachable")}{" "}
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:shadow-focus"
            onClick={() => void linked.query.refetch()}
          >
            {t("agents.questions.tryAgain")}
          </button>
        </p>
      )}
    </div>
  );
}
