import type { RaisedQuestionAsker, RaisedQuestionState, RaisedQuestionView } from "@forge/contracts/comments";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { type AskScope, questionDeskApi } from "./api";

/** Every query key the question desk reads under. */
export const questionDeskKeys = {
  raised: (projectId: string, by: RaisedQuestionAsker, state: RaisedQuestionState) => ["raised-questions", projectId, by, state] as const,
  targets: (projectId: string, scope: AskScope) => ["question-targets", projectId, scope] as const,
};

/** Polled, since an answer lands in a thread no event here names. */
const RAISED_POLL_MS = 30_000;

/**
 * How many rows of a state one page reads. Owed is what the page is for, so it reads more at once;
 * answered and closed, mostly release records with a "Thanks.", are read 20 at a time.
 */
export const RAISED_PAGE: Record<RaisedQuestionState, number> = { owed: 50, answered: 20, closed: 20 };

/**
 * The raised questions in one state, a page at a time, read only while `enabled` (an answered or
 * closed group is read once a reader opens it). `counts` are core's, over every state. `fold` drops
 * every page but the first, so a group opened again starts at one page.
 */
export function useRaisedGroup(projectId: string, by: RaisedQuestionAsker, state: RaisedQuestionState, enabled = true) {
  const qc = useQueryClient();
  const queryKey = questionDeskKeys.raised(projectId, by, state);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => questionDeskApi.raised(projectId, by, state, pageParam, RAISED_PAGE[state]),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.questions.length, 0);
      return last.questions.length > 0 && loaded < last[state] ? loaded : undefined;
    },
    enabled: Boolean(projectId) && enabled,
    staleTime: 15_000,
    refetchInterval: RAISED_POLL_MS,
  });
  const pages = query.data?.pages ?? [];
  // offset pages can repeat a row when one is asked between reads; it is listed once
  const rows = [...new Map(pages.flatMap((p) => p.questions).map((q): [string, RaisedQuestionView] => [q.id, q])).values()];
  const fold = () =>
    qc.setQueryData<{ pages: unknown[]; pageParams: unknown[] }>(queryKey, (d) => (d ? { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) } : d));
  return { query, rows, counts: pages.at(-1), fold };
}

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
