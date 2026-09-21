export type { AgentSelf, AgentSelfPatch, PresenceConfig } from "@forge/contracts";

export interface AgentAccountRow {
  userId: string;
  handle: string;
  displayName: string | null;
  email: string;
  projects: { id: string; role: string }[];
  createdAt: string;
  activeTokens: number;
  canAct: boolean;
}

export interface AgentCredentialFence {
  boundProjectId: string | null;
  projectIds: string[] | null;
}

/** `POST /api/orgs/:orgId/agents/:agentUserId/tokens`. Shown once and never read back. */
export interface AgentCredentialMinted {
  plaintext: string;
  fence: AgentCredentialFence;
}

/** `POST /api/orgs/:orgId/agents` — the new account, and its one credential. */
export interface AgentCreated extends AgentAccountRow {
  plaintext: string;
}

/** The body `POST /api/orgs/:orgId/agents` takes. `projectIds` is plural and required. */
export interface CreateAgentInput {
  handle: string;
  projectIds: string[];
}
