import { apiClient } from "@/lib/api/client";
import type { RegisterFilter } from "./routes";
import type {
  ApiPage,
  ContractVersion,
  DocumentType,
  DocumentView,
  Measurement,
  NamedProject,
  OutboxResponse,
  ProjectEcosystemsResponse,
  RegisterResponse,
  ThreadHold,
  ThreadView,
} from "./types";

/** The register's own status for each filter the page offers; "awaiting" is core's `open`. */
export const REGISTER_STATUS: Record<Exclude<RegisterFilter, "all">, string> = {
  awaiting: "open",
  overdue: "overdue",
  held: "held",
  answered: "answered",
  closed: "closed",
};

export interface DraftInput {
  type: DocumentType;
  to: string[];
  subject: string;
  dueBy?: string;
  inReplyTo?: string;
  body: unknown;
}

const channel = (projectId: string) => `/projects/${projectId}/channel`;
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const ecosystemApi = {
  ecosystemsOf: (projectId: string) =>
    apiClient<ProjectEcosystemsResponse>(`/projects/${projectId}/ecosystems`),

  register: (ecosystemId: string, opts: { filter: RegisterFilter; party: string }) => {
    const q = new URLSearchParams({ party: opts.party, limit: "500" });
    if (opts.filter !== "all") q.set("status", REGISTER_STATUS[opts.filter]);
    return apiClient<RegisterResponse>(`/ecosystems/${ecosystemId}/register?${q}`);
  },

  outbox: (projectId: string) => apiClient<OutboxResponse>(`${channel(projectId)}/outbox`),

  document: (projectId: string, ref: string) =>
    apiClient<DocumentView>(`${channel(projectId)}/documents/${encodeURIComponent(ref)}`),

  thread: (projectId: string, number: string) =>
    apiClient<ThreadView>(`${channel(projectId)}/threads/${encodeURIComponent(number)}`),

  draft: (projectId: string, ecosystem: string, input: DraftInput) =>
    apiClient<DocumentView>(`${channel(projectId)}/drafts`, json("POST", { ecosystem, ...input })),

  edit: (projectId: string, documentId: string, input: DraftInput) =>
    apiClient<DocumentView>(`${channel(projectId)}/documents/${documentId}`, json("PUT", input)),

  submit: (projectId: string, documentId: string) =>
    apiClient<DocumentView>(`${channel(projectId)}/documents/${documentId}/submit`, json("POST")),

  withdraw: (projectId: string, documentId: string, reason: string) =>
    apiClient<DocumentView>(
      `${channel(projectId)}/documents/${documentId}/withdraw`,
      json("POST", { reason }),
    ),

  supersede: (projectId: string, documentId: string, by: string, reason: string) =>
    apiClient<DocumentView>(
      `${channel(projectId)}/documents/${documentId}/supersede`,
      json("POST", { by, reason }),
    ),

  hold: (projectId: string, thread: string, action: "hold" | "release", reason?: string) =>
    apiClient<{ thread: string; held: boolean; hold: ThreadHold }>(
      `${channel(projectId)}/threads/${encodeURIComponent(thread)}/${action}`,
      json("POST", reason ? { reason } : {}),
    ),

  apiPage: (projectId: string) => apiClient<ApiPage>(`/projects/${projectId}/api-page`),

  ownVersions: (projectId: string, contract: string) =>
    apiClient<{ versions: ContractVersion[] }>(
      `/projects/${projectId}/contracts/${encodeURIComponent(contract)}/versions`,
    ),

  ownMeasurements: (projectId: string, contract: string) =>
    apiClient<{ measurements: Measurement[] }>(
      `/projects/${projectId}/contracts/${encodeURIComponent(contract)}/measurements`,
    ),

  consumedVersions: (projectId: string, provider: string, contract: string) =>
    apiClient<{ provider: NamedProject; contract: string; versions: ContractVersion[] }>(
      `/projects/${projectId}/consumes/${provider}/${encodeURIComponent(contract)}/versions`,
    ),

  consumedMeasurements: (projectId: string, provider: string, contract: string) =>
    apiClient<{ measurements: Measurement[] }>(
      `/projects/${projectId}/consumes/${provider}/${encodeURIComponent(contract)}/measurements`,
    ),
};
