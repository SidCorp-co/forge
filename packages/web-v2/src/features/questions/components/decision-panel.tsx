"use client";


import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Skeleton,
  Textarea,
} from "@/design";
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

/** A question a park asked only in the thread: no question row carries it (ISS-1310). */
export interface ThreadQuestion {
  prompt: string | null;
  readings: string[];
}

/**
 * The question as the run wrote it in the thread, answered where it is shown. The run reads a
 * person's comment posted after its park as the answer, so the answer goes up as that comment.
 */
function ThreadQuestionCard({
  question,
  onAnswer,
}: {
  question: ThreadQuestion;
  /** Absent for a reader who may not write: the question is shown, and no box. */
  onAnswer?: ((text: string) => Promise<unknown>) | undefined;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const trimmed = text.trim();
  const send = async () => {
    if (!onAnswer) return;
    setSending(true);
    try {
      await onAnswer(trimmed);
      setSent(true);
      setText("");
    } finally {
      setSending(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>The question this issue is waiting on</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="fg-caption text-muted">
          The run asked this in the thread rather than as a decision round.
        </p>
        {question.prompt && <p className="fg-body-sm whitespace-pre-wrap text-fg">{question.prompt}</p>}
        {question.readings.length > 0 && (
          <ul className="fg-body-sm list-disc space-y-1 pl-5 text-fg">
            {question.readings.map((reading) => (
              <li key={reading}>{reading}</li>
            ))}
          </ul>
        )}
        {!onAnswer ? null : sent ? (
          <p role="status" className="fg-body-sm text-fg">
            Your answer is on the thread. Resume the issue from its status when it can go on.
          </p>
        ) : (
          <>
            <Field label="Your answer" required>
              <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                loading={sending}
                disabled={trimmed.length === 0 || sending}
                onClick={send}
              >
                Post answer
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Every question on this issue — or, on an issue parked for information with none,
 * the question its park asked in the thread, or what was looked for and where else
 * the asking may have gone.
 */
export function DecisionPanel({
  issueId,
  parkedForInfo = false,
  threadQuestion = null,
  onAnswerInThread,
}: {
  issueId: string;
  parkedForInfo?: boolean;
  threadQuestion?: ThreadQuestion | null;
  onAnswerInThread?: (text: string) => Promise<unknown>;
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
      ) : questions.length === 0 && threadQuestion ? (
        <ThreadQuestionCard question={threadQuestion} onAnswer={onAnswerInThread} />
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
