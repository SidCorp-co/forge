import type { RaisedQuestionAsker } from "@forge/contracts/comments";
import { useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { type AskScope, questionDeskApi } from "./api";

/** Every query key the question desk reads under. */
export const questionDeskKeys = {
  raised: (projectId: string, by: RaisedQuestionAsker) => ["raised-questions", projectId, by] as const,
  targets: (projectId: string, scope: AskScope) => ["question-targets", projectId, scope] as const,
};

/** Polled, since an answer lands in a thread no event here names. */
const RAISED_POLL_MS = 30_000;

export const useRaisedQuestions = (projectId: string, by: RaisedQuestionAsker) =>
  useQuery({ ...readOf(questionDeskKeys.raised(projectId, by), () => questionDeskApi.raised(projectId, by)), refetchInterval: RAISED_POLL_MS });

/** The records a question can be about, read only for a product scope (an issue is picked by search). */
export const useAskTargets = (projectId: string, scope: AskScope) =>
  useQuery({
    ...readOf(questionDeskKeys.targets(projectId, scope), () => questionDeskApi.targets(projectId, scope as Exclude<AskScope, "issue">), 60_000),
    enabled: Boolean(projectId) && scope !== "issue",
  });

/** Raise a question; the raised list and the record's own thread are read again. */
export const useAsk = (projectId: string) =>
  useWrite(({ scope, ref, body }: { scope: AskScope; ref: string; body: string }) => questionDeskApi.ask(projectId, scope, ref, body), {
    touches: [["raised-questions", projectId], ["entity-comments", projectId]],
  });
