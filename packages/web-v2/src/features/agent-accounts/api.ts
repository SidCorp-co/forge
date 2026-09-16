
import { apiClient } from "@/lib/api/client";
import type { AgentAccountRow, AgentCredentialMinted, AgentSelf, AgentSelfPatch } from "./types";

export const agentAccountsApi = {
  /** `GET /api/orgs/:orgId/agents` */
  list: (orgId: string) =>
    apiClient<{ agents: AgentAccountRow[] }>(`/orgs/${orgId}/agents`).then((r) => r.agents),

  /** `POST /api/orgs/:orgId/agents/:agentUserId/tokens` — the plaintext, once. */
  mintCredential: (orgId: string, agentUserId: string) =>
    apiClient<AgentCredentialMinted>(`/orgs/${orgId}/agents/${agentUserId}/tokens`, {
      method: "POST",
    }),

  /** `DELETE /api/orgs/:orgId/agents/:agentUserId/tokens` — authority off, account intact. */
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
