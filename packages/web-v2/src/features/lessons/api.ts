import type {
  ChatLessonMarks,
  LessonResolution,
  LessonResponse,
  LessonsMonthView,
  LessonsResponse,
} from "@forge/contracts/lessons";
import { apiClient } from "@/lib/api/client";

const base = (projectId: string) => `/projects/${projectId}/lessons`;
const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** A person's decision on one lesson, by its key (`L-3`). */
export type LessonAct =
  | { kind: "approve"; key: string; sentence?: string }
  | { kind: "edit"; key: string; sentence: string }
  | { kind: "reject" | "retire"; key: string; reason: string }
  | { kind: "keep"; key: string };

export interface ConfusionDecision {
  id: string;
  resolution: LessonResolution;
  sentence?: string;
}

function act(projectId: string, a: LessonAct): Promise<LessonResponse> {
  const at = `${base(projectId)}/${a.key}`;
  switch (a.kind) {
    case "approve":
      return apiClient<LessonResponse>(`${at}/approve`, post(a.sentence ? { sentence: a.sentence } : {}));
    case "edit":
      return apiClient<LessonResponse>(at, { method: "PATCH", body: JSON.stringify({ sentence: a.sentence }) });
    case "keep":
      return apiClient<LessonResponse>(`${at}/keep`, post());
    default:
      return apiClient<LessonResponse>(`${at}/${a.kind}`, post({ reason: a.reason }));
  }
}

export const lessonsApi = {
  list: (projectId: string) => apiClient<LessonsResponse>(base(projectId)),
  month: (projectId: string, month: string) => apiClient<LessonsMonthView>(`${base(projectId)}/month?month=${month}`),
  act,
  decideConfusion: (projectId: string, d: ConfusionDecision) =>
    apiClient<LessonResponse>(
      `${base(projectId)}/confusions/${d.id}/decide`,
      post(d.sentence ? { resolution: d.resolution, sentence: d.sentence } : { resolution: d.resolution }),
    ),
  dismissCorrection: (projectId: string, id: string) => apiClient<void>(`${base(projectId)}/corrections/${id}/dismiss`, post()),
  markWrong: (projectId: string, applicationId: string, reason: string) =>
    apiClient<LessonResponse>(`${base(projectId)}/applications/${applicationId}/wrong`, post({ reason })),
  chat: (projectId: string, conversationId: string) => apiClient<ChatLessonMarks>(`${base(projectId)}/chat/${conversationId}`),
};
