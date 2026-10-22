// The open questions a close or drop would end, shown where the move is made and answerable there
// (ISS-560, FB-130). A move to `closed` or `dropped` voids every open question on the issue with
// the reason it carries (core `questions/issue-coupling.ts:settleOpenQuestions`), so the person sees
// each one first, answers any still worth answering, and the move ends the rest in the same act.

import { ISSUE_TERMINAL_STATUSES } from "@forge/contracts/issue-machine";
import { type AgentQuestion, QuestionView, useAnsweringQuestions, useAnswerQuestion, useIssueQuestions } from "@/features/questions";
import { useCopy } from "@/lib/i18n/interface-language";
import type { IssueStatus } from "../types";

/** Whether a move to `to` ends the issue, and with it every open question on it. */
export const endsTheIssue = (to: IssueStatus | null | undefined): boolean =>
  to !== null && to !== undefined && ISSUE_TERMINAL_STATUSES.includes(to);

/** The questions core voids with such a move: every one still `open` on the issue. */
export const openQuestionsOf = (questions: readonly AgentQuestion[] | undefined): AgentQuestion[] =>
  (questions ?? []).filter((q) => q.status === "open");

/** The issue's open questions, read only while `issueId` is given (a move that ends the issue). */
export function useMootQuestions(issueId: string | null | undefined) {
  const read = useIssueQuestions(issueId ?? "");
  return { open: openQuestionsOf(read.data?.questions), loading: Boolean(issueId) && read.isLoading };
}

/** Each open question on the issue, answerable in place; nothing when none is open. */
export function MootQuestions({ issueId }: { issueId: string }) {
  const t = useCopy();
  const { open } = useMootQuestions(issueId);
  const mutation = useAnswerQuestion(issueId);
  const { answering, answer } = useAnsweringQuestions(mutation.mutateAsync);
  if (open.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="moot-questions">
      <p className="fg-body-sm font-semibold text-fg">{t("issues.moot.title", { n: open.length })}</p>
      {open.map((question) => (
        <QuestionView key={question.id} question={question} onAnswer={answer} pending={answering.has(question.id)} />
      ))}
    </div>
  );
}
