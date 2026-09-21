
import { apiClient } from "@/lib/api/client";
import type { AgentQuestion, AnswerInput, QuestionListResponse } from "./types";

export const PROJECT_PAGE_SIZE = 50;

export const questionsApi = {
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
