import { apiClient } from "@/lib/api/client";
import type { Bus, BuilderRunRecord, LinkRecord } from "./bus";
import type {
  ApiPage,
  ContractVersion,
  DocumentType,
  DocumentView,
  EcosystemDocument,
  HeldEcosystem,
  Measurement,
  NamedProject,
  OutboxResponse,
  ProjectEcosystemsResponse,
  ThreadHold,
  ThreadView,
  WorkspaceRead,
} from "./types";

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
  mine: () => apiClient<WorkspaceRead>("/ecosystems/mine"),

  read: (ecosystemId: string) => apiClient<HeldEcosystem>(`/ecosystems/${ecosystemId}`),

  create: (document: EcosystemDocument) =>
    apiClient<HeldEcosystem>("/ecosystems", json("POST", { baseRevision: null, document })),

  write: (ecosystemId: string, baseRevision: number, document: EcosystemDocument) =>
    apiClient<HeldEcosystem>(`/ecosystems/${ecosystemId}`, json("PUT", { baseRevision, document })),

  decide: (membershipId: string, verb: "accept" | "decline") =>
    apiClient<unknown>(`/memberships/${membershipId}/${verb}`, json("POST")),

  bus: (ecosystemId: string) => apiClient<Bus>(`/ecosystems/${ecosystemId}/bus`),

  link: (consumerId: string, linkId: string) =>
    apiClient<LinkRecord>(`/projects/${consumerId}/links/${linkId}`),

  builderRun: (projectId: string, runId: string) =>
    apiClient<BuilderRunRecord>(`/projects/${projectId}/builder-runs/${runId}`),

  invite: (ecosystemId: string, projectId: string) =>
    apiClient<unknown>(`/ecosystems/${ecosystemId}/invitations`, json("POST", { project: projectId })),

  ecosystemsOf: (projectId: string) =>
    apiClient<ProjectEcosystemsResponse>(`/projects/${projectId}/ecosystems`),

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
