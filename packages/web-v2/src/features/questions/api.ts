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
  listOpenForProject: (projectId: string, cursor?: string, limit = PROJECT_PAGE_SIZE) =>
    apiClient<QuestionListResponse>(
      `/questions?projectId=${encodeURIComponent(projectId)}&status=open&limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    ),

  /** `GET /api/questions/:id` — one decision, whole, whatever page it would have been on. */
  get: (questionId: string) => apiClient<AgentQuestion>(`/questions/${questionId}`),

  /** `POST /api/questions/:id/answer` — answer the round it was shown on, by option or in words. */
  answer: ({ questionId, round, ...given }: AnswerInput) =>
    apiClient<AgentQuestion>(`/questions/${questionId}/answer`, {
      method: "POST",
      body: JSON.stringify(
        given.optionId ? { optionId: given.optionId, round } : { text: given.text, round },
      ),
    }),
};
