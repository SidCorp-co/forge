"use client";

// The structured decision a parked run is waiting on, on the issue screen.
//
// This is the `agent_questions` ROW, and since ISS-996 it is the ONLY lane: a
// park at `needs_info` mints its own question, answered by option or in words.
// The comment thread below records what was asked; answering there moves
// nothing.
//
// The card itself lives in `question-card.tsx` because the project-wide queue on
// the Agents screen renders the same one; this file is the issue-scoped fetch,
// its read states, and the park that carries no question at all.

import { Card, CardContent, CardHeader, CardTitle, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAnsweringQuestions, useAnswerQuestion, useIssueQuestions } from "../hooks";
import { QuestionCard } from "./question-card";

export const DECISION_PANEL_ANCHOR = "issue-decisions";

function NothingToAnswer() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Nothing to answer here</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="fg-body-sm text-fg">
          This issue was parked without a question, so there is no round to answer on this screen.
        </p>
        <p className="fg-caption text-muted">
          A comment does not restart the run. Once whoever is waiting has what they need, move the
          issue on from the header.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Every question on this issue — or, on an issue parked for information with none,
 * a statement that there is nothing here to answer.
 */
export function DecisionPanel({
  issueId,
  parkedForInfo = false,
}: {
  issueId: string;
  parkedForInfo?: boolean;
}) {
  const { data, isLoading, isError, error, refetch } = useIssueQuestions(issueId);
  const mutation = useAnswerQuestion(issueId);
  const { answering, answer } = useAnsweringQuestions(mutation.mutateAsync);
  const questions = data?.questions ?? [];

  if (!parkedForInfo && !isLoading && !isError && questions.length === 0) return null;

  return (
    <div id={DECISION_PANEL_ANCHOR} className="space-y-3">
      {isLoading ? (
        <Skeleton variant="rect" className="h-24 w-full" />
      ) : isError ? (
        <ErrorState
          title="Couldn't load this issue's decisions"
          message={formatApiError(error)}
          onRetry={() => refetch()}
        />
      ) : questions.length === 0 ? (
        <NothingToAnswer />
      ) : (
        questions.map((question) => (
          <QuestionCard
            key={question.id}
            question={question}
            onAnswer={answer}
            pending={answering.has(question.id)}
          />
        ))
      )}
    </div>
  );
}
