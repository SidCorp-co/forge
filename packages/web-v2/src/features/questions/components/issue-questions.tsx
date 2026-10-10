"use client";

import type { ParkThreadQuestion } from "@forge/contracts/park";
import { useState } from "react";
import { Button, ErrorState, Field, LoadingState, Section, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAnsweringQuestions, useAnswerQuestion, useIssueQuestions } from "../hooks";
import { QuestionView } from "./question-view";

const QUESTIONS_ANCHOR = "issue-decisions";

/** The gap left between a sticky header and the question it would otherwise cover. */
const BELOW_HEADER_PX = 12;

/**
 * Bring the questions into view with their first line below `stickyHeader`, which a plain
 * `scrollIntoView` scrolls them under — on a phone the header wraps and covers the prompt.
 */
export function focusIssueQuestions(stickyHeader: HTMLElement | null): void {
  const panel = document.getElementById(QUESTIONS_ANCHOR);
  if (!panel) return;
  panel.style.scrollMarginTop = `${(stickyHeader?.offsetHeight ?? 0) + BELOW_HEADER_PX}px`;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * What this panel found, and nothing about why.
 *
 * It said "This issue was parked without a question" until ISS-1210. It knows
 * one thing — that the issue's own question list came back empty — and that
 * sentence is a claim about the record, which it never read: an owner read it
 * on an issue whose thread carried the question in full and stopped for
 * nineteen hours. So the heading reports the query and nothing else: no line
 * explains what to do next (REQ-43 BC-4).
 */
function NothingToAnswer() {
  const t = useCopy();
  return (
    <Section title={t("agents.decision.none")} />
  );
}

/**
 * The question as the run wrote it in the thread, answered where it is shown. The run reads a
 * person's comment posted after it stopped as the answer, so the answer goes up as that comment,
 * and once one is there the card shows it and asks nothing more.
 */
function ThreadQuestion({
  question,
  onAnswer,
}: {
  question: ParkThreadQuestion;
  /** Absent for a reader who may not write: the question is shown, and no box. */
  onAnswer?: ((text: string) => Promise<unknown>) | undefined;
}) {
  const t = useCopy();
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
  const answer = question.answer;
  return (
    <Section title={answer ? t("agents.decision.asked") : t("agents.decision.waitingOn")} className="space-y-3">
        <p className="fg-caption text-muted">{t("agents.decision.inComments")}</p>
        {question.prompt && <p className="fg-body-sm whitespace-pre-wrap text-fg">{question.prompt}</p>}
        {question.why && (
          <p className="fg-body-sm text-muted">
            <span className="text-fg">{t("agents.decision.whyStopped")}</span> {question.why}
          </p>
        )}
        {question.readings.length > 0 && (
          <ul className="fg-body-sm list-disc space-y-1 pl-5 text-fg">
            {question.readings.map((reading) => (
              <li key={`${reading.choice}-${reading.outcome ?? ""}`}>
                <span className="font-medium">{reading.choice}</span>
                {reading.outcome && <span className="text-muted"> — {reading.outcome}</span>}
              </li>
            ))}
          </ul>
        )}
        {answer ? (
          <div role="status" className="space-y-1 border-l-2 border-line pl-3">
            <p className="fg-caption text-muted">{t("agents.decision.answeredIn")}</p>
            <p className="fg-body-sm whitespace-pre-wrap text-fg">{answer.text}</p>
          </div>
        ) : !onAnswer ? null : sent ? (
          <p role="status" className="fg-body-sm text-fg">
            {t("agents.decision.onThread")}
          </p>
        ) : (
          <>
            <Field label={t("agents.question.yourAnswer")} required>
              <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                loading={sending}
                disabled={trimmed.length === 0 || sending}
                onClick={() => void send()}
              >
                {t("agents.decision.post")}
              </Button>
            </div>
          </>
        )}
    </Section>
  );
}

/**
 * Every question on this issue — or, on an issue parked for information with none,
 * the question its park asked in the thread, or what was looked for and where else
 * the asking may have gone.
 */
export function IssueQuestions({
  issueId,
  parkedForInfo = false,
  threadQuestion = null,
  onAnswerInThread,
  show = "all",
}: {
  issueId: string;
  parkedForInfo?: boolean;
  threadQuestion?: ParkThreadQuestion | null;
  onAnswerInThread?: (text: string) => Promise<unknown>;
  /** `now`: what a person can still answer, drawn on a page's first screen. `past`: the answered, voided and expired ones, which a page keeps in its Activity. `all`: every one, where the panel is the page. */
  show?: "now" | "past" | "all";
}) {
  const t = useCopy();
  const { data, isLoading, isError, error, refetch } = useIssueQuestions(issueId);
  const mutation = useAnswerQuestion(issueId);
  const { answering, answer } = useAnsweringQuestions(mutation.mutateAsync);
  const all = data?.questions ?? [];
  const questions = show === "all" ? all : all.filter((q) => (q.status === "open" || q.status === "needs_info") === (show === "now"));

  if (show === "past") {
    if (isLoading || isError || questions.length === 0) return null;
    return (
      <div className="space-y-3" data-testid="past-questions">
        {questions.map((question) => (
          <QuestionView key={question.id} question={question} onAnswer={answer} pending={answering.has(question.id)} />
        ))}
      </div>
    );
  }
  if (!parkedForInfo && !isLoading && !isError && questions.length === 0) return null;

  return (
    <div id={QUESTIONS_ANCHOR} className="space-y-3">
      {isLoading ? (
        <LoadingState rows={3} />
      ) : isError ? (
        <ErrorState
          title={t("agents.decision.loadFailed")}
          message={formatApiError(error)}
          onRetry={() => void refetch()}
        />
      ) : questions.length === 0 && threadQuestion ? (
        <ThreadQuestion question={threadQuestion} onAnswer={onAnswerInThread} />
      ) : questions.length === 0 ? (
        <NothingToAnswer />
      ) : (
        questions.map((question) => (
          <QuestionView
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
