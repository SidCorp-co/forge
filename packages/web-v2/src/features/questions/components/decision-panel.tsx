"use client";


import { Card, CardContent, CardHeader, CardTitle, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAnsweringQuestions, useAnswerQuestion, useIssueQuestions } from "../hooks";
import { QuestionCard } from "./question-card";

export const DECISION_PANEL_ANCHOR = "issue-decisions";

/**
 * What this panel found, and nothing about why.
 *
 * It said "This issue was parked without a question" until ISS-1210. It knows
 * one thing — that the issue's own question list came back empty — and that
 * sentence is a claim about the record, which it never read: an owner read it
 * on an issue whose thread carried the question in full and stopped for
 * nineteen hours. So the heading reports the query, and the way forward is the
 * card's content rather than a footnote under a dismissal.
 */
function NothingToAnswer() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No decision round on this issue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="fg-body-sm text-fg">
          Move the issue on from the header once whoever is waiting has what they need. A comment
          does not restart the run.
        </p>
        <p className="fg-caption text-muted">
          This panel lists the questions filed against this issue, and there are none. A run that
          asked in the thread instead leaves nothing here — read the comments.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Every question on this issue — or, on an issue parked for information with none,
 * what was looked for and where else the asking may have gone.
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
