// cm:edge contract -> packages/core/src/orgs/agent-accounts-routes.ts — the paths and their bodies are the wire shape. `/api/orgs` is deliberately absent from the PAT surface, so every call here is a signed-in org admin's and none of it is reachable by a token.

import { apiClient } from "@/lib/api/client";
import type { AgentAccountRow, AgentCredentialMinted } from "./types";

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
};
