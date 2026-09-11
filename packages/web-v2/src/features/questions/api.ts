// web-v2 feature module: parked decisions — REST surface.
//
// The routes are core's `questionRoutes` (`packages/core/src/questions/routes.ts`),
// mounted at `/api`. Nothing here interprets a refusal; `ApiError.code` carries it.

import { apiClient } from "@/lib/api/client";
import type { AgentQuestion, AnswerInput, QuestionListResponse } from "./types";

export const questionsApi = {
  /** `GET /api/questions?issueId=` — every question on one issue, newest first. */
  listForIssue: (issueId: string) =>
    apiClient<QuestionListResponse>(`/questions?issueId=${encodeURIComponent(issueId)}`),

  // cm:guard `round` travels with every answer and is never filled in from the question the client happens to hold: core refuses a round that is not the current one, and that refusal is the whole of the stale-screen protection (ISS-980 criterion 39).
  /** `POST /api/questions/:id/answer` — choose one option on the round it was shown on. */
  answer: ({ questionId, optionId, round }: AnswerInput) =>
    apiClient<AgentQuestion>(`/questions/${questionId}/answer`, {
      method: "POST",
      body: JSON.stringify({ optionId, round }),
    }),
};
