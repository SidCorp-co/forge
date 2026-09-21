
import { apiClient } from "@/lib/api/client";
import type {
  AgentAccountRow,
  AgentCreated,
  AgentCredentialMinted,
  AgentSelf,
  AgentSelfPatch,
  CreateAgentInput,
} from "./types";

export const agentAccountsApi = {
  /** `GET /api/orgs/:orgId/agents` */
  list: (orgId: string) =>
    apiClient<{ agents: AgentAccountRow[] }>(`/orgs/${orgId}/agents`).then((r) => r.agents),

  create: (orgId: string, input: CreateAgentInput) =>
    apiClient<AgentCreated>(`/orgs/${orgId}/agents`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** `PUT /api/orgs/:orgId/agents/:agentUserId/projects` — the whole set, sent whole. */
  setProjects: (orgId: string, agentUserId: string, projectIds: string[]) =>
    apiClient<{ projects: string[]; refenced: number }>(
      `/orgs/${orgId}/agents/${agentUserId}/projects`,
      { method: "PUT", body: JSON.stringify({ projectIds }) },
    ),

  /** `POST /api/orgs/:orgId/agents/:agentUserId/tokens` — the plaintext, once. */
  mintCredential: (orgId: string, agentUserId: string) =>
    apiClient<AgentCredentialMinted>(`/orgs/${orgId}/agents/${agentUserId}/tokens`, {
      method: "POST",
    }),

  revokeCredentials: (orgId: string, agentUserId: string) =>
    apiClient<{ revoked: number }>(`/orgs/${orgId}/agents/${agentUserId}/tokens`, {
      method: "DELETE",
    }),

  /** `PATCH /api/orgs/:orgId/agents/:agentUserId` — the label only. */
  setDisplayName: (orgId: string, agentUserId: string, displayName: string | null) =>
    apiClient<{ displayName: string | null }>(`/orgs/${orgId}/agents/${agentUserId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),
  /** `GET /api/orgs/:orgId/agents/:agentUserId/self` — who the agent is, and when it speaks (ISS-1034). */
  getSelf: (orgId: string, agentUserId: string) =>
    apiClient<AgentSelf>(`/orgs/${orgId}/agents/${agentUserId}/self`),
  /** `PATCH …/self` — any subset; 400 `PRESENCE_INVALID` names the key and its bound. */
  updateSelf: (orgId: string, agentUserId: string, patch: AgentSelfPatch) =>
    apiClient<AgentSelf>(`/orgs/${orgId}/agents/${agentUserId}/self`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};
