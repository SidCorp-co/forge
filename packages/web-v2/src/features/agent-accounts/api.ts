// cm:edge contract -> packages/core/src/orgs/agent-accounts-routes.ts — the paths and their bodies are the wire shape. `/api/orgs` is deliberately absent from the PAT surface, so every call here is a signed-in org admin's and none of it is reachable by a token.

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

  /**
   * `POST /api/orgs/:orgId/agents` — a new agent and its first credential.
   * The body is `.strict()` server-side: `projectIds` is plural and at least one.
   */
  // cm:guard `projectIds` and never `projectId`. The route's schema is strict, so the singular key is refused BY NAME rather than read as "no projects named"; sending it from here would turn that refusal into a 400 an admin cannot act on from a form that looks right (ISS-1093).
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
