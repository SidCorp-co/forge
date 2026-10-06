
import { apiClient } from "@/lib/api/client";
import type { AgentQuestion, AnswerInput, QuestionListResponse } from "./types";

const PROJECT_PAGE_SIZE = 50;

export const questionsApi = {
  listForIssue: (issueId: string) =>
    apiClient<QuestionListResponse>(`/questions?issueId=${encodeURIComponent(issueId)}`),

  /** One page of the open decisions that name no issue; one on an issue is answered there. */
  listOpenWithoutIssue: (projectId: string, cursor?: string, limit = PROJECT_PAGE_SIZE) =>
    apiClient<QuestionListResponse>(
      `/questions?projectId=${encodeURIComponent(projectId)}&status=open&issue=none&limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    ),

  /** `GET /api/questions/:id` — one decision, whole, whatever page it would have been on. */
  get: (questionId: string) => apiClient<AgentQuestion>(`/questions/${questionId}`),

  /** `POST /api/questions/:id/answer` — answer the round it was shown on, by option or in words. */
  answer: ({ questionId, round, note, stillWaits, ...given }: AnswerInput) =>
    apiClient<AgentQuestion>(`/questions/${questionId}/answer`, {
      method: "POST",
      body: JSON.stringify({
        ...(given.optionId ? { optionId: given.optionId } : { text: given.text }),
        round,
        ...(note === undefined ? {} : { note }),
        ...(stillWaits ? { stillWaits } : {}),
      }),
    }),
};
