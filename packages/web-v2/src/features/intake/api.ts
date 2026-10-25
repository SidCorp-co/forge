import { apiClient } from "@/lib/api/client";
import type { IntakeAnswerRequest, IntakeDraftResponse, IntakeKeepRequest } from "./types";

const one = (projectId: string, ref: string) => `/projects/${projectId}/intake-drafts/${encodeURIComponent(ref)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const intakeApi = {
  /** The intake assistant's draft of one requirement (REQ-n) or feedback item (FB-n), or null while none was made. */
  draft: (projectId: string, ref: string) => apiClient<IntakeDraftResponse>(one(projectId, ref)),
  /** Answers one of the draft's questions with one of its options (REQ-65 BC-3). */
  answer: (projectId: string, ref: string, body: IntakeAnswerRequest) => apiClient<IntakeDraftResponse>(`${one(projectId, ref)}/answers`, post(body)),
  /** Keeps a requirement its value check refused, with a one-line reason (REQ-65 BC-6). */
  keep: (projectId: string, ref: string, body: IntakeKeepRequest) => apiClient<IntakeDraftResponse>(`${one(projectId, ref)}/keep`, post(body)),
};
