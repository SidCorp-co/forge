
import { apiClient } from "@/lib/api/client";
import type { AgentQuestion, AnswerInput, QuestionListResponse } from "./types";
import { isUuid } from "@/lib/api/ref-bridge";

export const questionsApi = {
  listForIssue: (issueId: string, projectId?: string) =>
    apiClient<QuestionListResponse>(
      `/questions?issueId=${encodeURIComponent(issueId)}${projectId && !isUuid(issueId) ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
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
