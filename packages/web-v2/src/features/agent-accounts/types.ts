export type { AgentSelf, AgentSelfPatch, PresenceConfig } from "@forge/contracts";
// cm:edge contract -> packages/core/src/orgs/agent-accounts-routes.ts — these are the response shapes of `/api/orgs/:orgId/agents`; a field renamed there and not here fails only at runtime, and `orgs/agent-accounts.ts` is where the row is built.

/** One row of `GET /api/orgs/:orgId/agents`. */
export interface AgentAccountRow {
  userId: string;
  /** The address, the thing typed after `@`. Unique within this org. */
  handle: string;
  /** The label a person reads. Free text, not unique, null until someone types one. */
  displayName: string | null;
  /** Synthesized at a reserved-invalid domain. Shown as provenance, never as a name. */
  email: string;
  /**
   * Every project this agent is a member of, and the role it holds on each.
   * Empty for an agent that reaches none — the row an admin has to fix.
   */
  // cm:guard an ARRAY, and never the `projectId`/`projectRole` pair this used to be. An agent covers several projects since ISS-1093 and `listAgentAccounts` folds its memberships into one row; a reader still asking for the singular field reads `undefined`, which `reachOf` cannot tell from "belongs to no project" — the whole list would say every agent reaches nothing while the server said otherwise.
  projects: { id: string; role: string }[];
  createdAt: string;
  activeTokens: number;
  /**
   * Whether this agent holds a live credential AND a project for it to act on.
   * Both halves: the token is fenced to one project and the membership is what
   * answers on the other side, so either one missing means it can act nowhere.
   */
  // cm:guard read THIS and never `activeTokens > 0` at a call site: the server computes it from the same predicate the door verifies a token with, and a second derivation in the UI is how a screen starts saying an agent can act about a token the API turns away. It is NOT the flag to gate a REVOKE on, though — an agent with tokens and no project has authority to remove and `canAct` already reads false; `activeTokens` is what says there is something to take away (ISS-1003 criteria 2, 6, 7, and rule 4).
  canAct: boolean;
}

/**
 * The fence a credential carries: one project binds, several allowlist. The two
 * shapes are `orgs/agent-accounts.ts:fenceFor`'s and are never both populated.
 */
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
