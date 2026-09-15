// web-v2 feature module: parked decisions — REST surface.
//
// The routes are core's `questionRoutes` (`packages/core/src/questions/routes.ts`),
// mounted at `/api`. Nothing here interprets a refusal; `ApiError.code` carries it.

import { apiClient } from "@/lib/api/client";
import type { AgentQuestion, AnswerInput, QuestionListResponse } from "./types";

/** The page this queue asks for. Core's own default is the same number; naming it here keeps the two from drifting apart silently if either moves. */
export const PROJECT_PAGE_SIZE = 50;

export const questionsApi = {
  /** `GET /api/questions?issueId=` — every question on one issue, newest first. */
  listForIssue: (issueId: string) =>
    apiClient<QuestionListResponse>(`/questions?issueId=${encodeURIComponent(issueId)}`),

  /** `GET /api/questions?projectId=&status=open` — one page of open decisions on one project. */
  // cm:guard `projectId` and `issueId` are mutually exclusive on this route — core refuses a call naming both — and the project form is the ONLY one that reaches a question carrying `issueId: null`, which the device door can create and which no issue screen can therefore render (ISS-998).
  // cm:guard this route is PAGED since ISS-1022 and the caller must drain it: the answer carries `total` and `hasMore`, and a caller that reads `questions` alone shows the first page as if it were the queue. `limit` above 200 is refused by core rather than clamped.
  // cm:guard the next page is named by the previous one's `nextCursor` and NEVER by a running count: this queue is being answered while it is read, and an offset starts past a row that shifted backward when an earlier one closed — an open decision dropped from the walk with `hasMore` still reading complete. The cursor is opaque; do not parse it.
  listOpenForProject: (projectId: string, cursor?: string, limit = PROJECT_PAGE_SIZE) =>
    apiClient<QuestionListResponse>(
      `/questions?projectId=${encodeURIComponent(projectId)}&status=open&limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    ),

  /** `GET /api/questions/:id` — one decision, whole, whatever page it would have been on. */
  // cm:guard the AUTHORITATIVE read of one question, and the only sound way to conclude that a linked decision is gone: a question answered between two fetches leaves the queue while the walk is still in it, so the walk can finish without ever having seen it. A 404 here is the fact; a question missing from every page read is not, and neither is a 500 (ISS-1022).
  get: (questionId: string) => apiClient<AgentQuestion>(`/questions/${questionId}`),

  // cm:guard `round` travels with every answer and is never filled in from the question the client happens to hold: core refuses a round that is not the current one, and that refusal is the whole of the stale-screen protection (ISS-980 criterion 39).
  // cm:guard the body carries optionId XOR text and never both — core refuses a body with both rather than picking one, so the spread below must not be widened into sending an empty `text` beside an option (ISS-996).
  /** `POST /api/questions/:id/answer` — answer the round it was shown on, by option or in words. */
  answer: ({ questionId, round, ...given }: AnswerInput) =>
    apiClient<AgentQuestion>(`/questions/${questionId}/answer`, {
      method: "POST",
      body: JSON.stringify(
        given.optionId ? { optionId: given.optionId, round } : { text: given.text, round },
      ),
    }),
};
