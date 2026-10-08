import { apiClient } from "@/lib/api/client";
import type {
  CreateFeedbackRequest,
  FeedbackAction,
  FeedbackEndpointsResponse,
  FeedbackListResponse,
  FeedbackMessageAudience,
  FeedbackMessagePreviewResponse,
  FeedbackPromoteEffect,
  FeedbackResponse,
  PromoteAgentReportRequest,
} from "./types";

const base = (projectId: string) => `/projects/${projectId}/feedback`;
const one = (projectId: string, key: string) => `${base(projectId)}/${encodeURIComponent(key)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

function actionRequest(projectId: string, key: string, a: FeedbackAction): [string, RequestInit] {
  if (a.kind === "redact") return [`${one(projectId, key)}/reporter-data`, { method: "DELETE" }];
  if (a.kind === "triage") return [`${one(projectId, key)}/triage`, post(a.triage)];
  if (a.kind === "retarget") return [`${one(projectId, key)}/retarget`, post(a.request)];
  if (a.kind === "accept") return [`${one(projectId, key)}/accept`, post(a.requirement ? { requirement: a.requirement } : {})];
  if (a.kind === "snooze") return [`${one(projectId, key)}/snooze`, post({ until: a.until, reason: a.reason })];
  if (a.kind === "verify-ask") return [`${one(projectId, key)}/verify-ask`, post({})];
  if (a.kind === "verify") return [`${one(projectId, key)}/verify`, post(a.note ? { note: a.note } : {})];
  return [`${one(projectId, key)}/${a.kind}`, post({ reason: a.reason })];
}

/** A file as core's feedback attachment route takes it: its name, its type and its bytes as base64. */
export function attachmentBody(file: File): Promise<{ name: string; mime: string; contentBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} could not be read`));
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name, mime: file.type || "application/octet-stream", contentBase64: url.slice(url.indexOf(",") + 1) });
    };
    reader.readAsDataURL(file);
  });
}

/** One file core would not keep, after the files before it were: the item stands, and so do those. */
export class AttachFailed extends Error {
  constructor(
    readonly key: string,
    readonly file: string,
    readonly refusal: unknown,
  ) {
    super(`${file} was not attached to ${key}`);
  }
}

/** One thing About can name: `key` is what core is sent, `title` what the person reads and searches. */
export interface TargetChoice {
  key: string;
  title: string;
}

export const feedbackApi = {
  list: (projectId: string) => apiClient<FeedbackListResponse>(base(projectId)),
  get: (projectId: string, key: string) => apiClient<FeedbackResponse>(one(projectId, key)),
  /** What a person picks About from: the project's requirements and releases by title, its workflows by flow, read as the lists' own routes serve them. */
  choices: async (projectId: string, type: "requirement" | "workflow" | "release"): Promise<TargetChoice[]> => {
    if (type === "requirement") {
      const r = await apiClient<{ requirements: { key: string; title: string }[] }>(`/projects/${projectId}/requirements`);
      return r.requirements.map((q) => ({ key: q.key, title: q.title }));
    }
    if (type === "workflow") {
      const r = await apiClient<{ workflows: { document: { flow: string; title: string } }[] }>(`/projects/${projectId}/workflows`);
      return r.workflows.map((w) => ({ key: w.document.flow, title: w.document.title }));
    }
    const r = await apiClient<{ releases: { version: string }[] }>(`/projects/${projectId}/releases`);
    return r.releases.map((v) => ({ key: v.version, title: v.version }));
  },
  endpoints: (projectId: string) => apiClient<FeedbackEndpointsResponse>(`${base(projectId)}/endpoints`),
  create: (projectId: string, body: CreateFeedbackRequest) => apiClient<FeedbackResponse>(base(projectId), post(body)),
  promote: (projectId: string, body: PromoteAgentReportRequest) =>
    apiClient<FeedbackResponse & { effect: FeedbackPromoteEffect }>(`${base(projectId)}/promote`, post(body)),
  /** The exact notice a send would deliver, and to whom; nothing is written. */
  previewMessage: (projectId: string, key: string, body: { audience: Exclude<FeedbackMessageAudience, "internal">; text: string }) =>
    apiClient<FeedbackMessagePreviewResponse>(`${one(projectId, key)}/messages/preview`, post(body)),
  sendMessage: (projectId: string, key: string, body: { audience: FeedbackMessageAudience; text: string; relayed?: boolean }) =>
    apiClient<FeedbackResponse>(`${one(projectId, key)}/messages`, post(body)),
  /** Tells the reporters now that the work shipped, in each one's language; refused once they were told. */
  tellShipped: (projectId: string, key: string) => apiClient<FeedbackResponse>(`${one(projectId, key)}/tell-shipped`, post({})),
  /** Each file in turn, so a refusal names the one core would not keep; the item reads as the last kept left it. */
  attach: async (projectId: string, key: string, files: readonly File[]): Promise<FeedbackResponse | null> => {
    let last: FeedbackResponse | null = null;
    for (const file of files) {
      try {
        last = await apiClient<FeedbackResponse>(`${one(projectId, key)}/attachments`, post(await attachmentBody(file)));
      } catch (err) {
        throw new AttachFailed(key, file.name, err);
      }
    }
    return last;
  },
  act: (projectId: string, key: string, a: FeedbackAction) => {
    const [path, init] = actionRequest(projectId, key, a);
    return apiClient<FeedbackResponse>(path, init);
  },
};
