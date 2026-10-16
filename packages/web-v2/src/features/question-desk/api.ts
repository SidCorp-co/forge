import type { RaisedQuestionAsker, RaisedQuestionState, RaisedQuestionsResponse } from "@forge/contracts/comments";
import { apiClient } from "@/lib/api/client";
import { commentsApi } from "@/features/comments";

/** What a question can be raised about: a product record, or an issue the project's agent works. */
export type AskScope = "requirement" | "feedback" | "workflow" | "issue";

/** One record a question can be about: `ref` is what core is sent, `label` what a person reads. */
export interface AskTarget {
  ref: string;
  label: string;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const questionDeskApi = {
  /** One page of the questions raised on the project in one state: the reader's own, or everyone's. */
  raised: (projectId: string, by: RaisedQuestionAsker, state: RaisedQuestionState, offset: number, limit: number) =>
    apiClient<RaisedQuestionsResponse>(`/projects/${projectId}/raised-questions?by=${by}&state=${state}&offset=${offset}&limit=${limit}`),

  /** The records of one scope a question can be about, by key and title. */
  targets: async (projectId: string, scope: Exclude<AskScope, "issue">): Promise<AskTarget[]> => {
    if (scope === "requirement") {
      const r = await apiClient<{ requirements: { key: string; title: string }[] }>(`/projects/${projectId}/requirements`);
      return r.requirements.map((q) => ({ ref: q.key, label: `${q.key} · ${q.title}` }));
    }
    if (scope === "feedback") {
      const r = await apiClient<{ feedback: { key: string; title: string }[] }>(`/projects/${projectId}/feedback`);
      return r.feedback.map((f) => ({ ref: f.key, label: `${f.key} · ${f.title}` }));
    }
    const r = await apiClient<{ workflows: { document: { flow: string; title: string } }[] }>(`/projects/${projectId}/workflows`);
    return r.workflows.map((w) => ({ ref: w.document.flow, label: w.document.title }));
  },

  /**
   * Raise a question as a `question` comment: on a product record through its comments route, on an
   * issue through the issue's thread, whose route takes the issue by its uuid, read first by key.
   */
  ask: async (projectId: string, scope: AskScope, ref: string, body: string): Promise<void> => {
    if (scope !== "issue") {
      await commentsApi.post(projectId, scope, ref, { intent: "question", body });
      return;
    }
    const issue = await apiClient<{ id: string }>(`/issues/${encodeURIComponent(ref)}?projectId=${encodeURIComponent(projectId)}`);
    await apiClient<unknown>(`/issues/${issue.id}/comments`, post({ intent: "question", body }));
  },
};
