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
  projectId: string;
  projectRole: string;
  createdAt: string;
  activeTokens: number;
  /**
   * Whether this agent holds a credential that is neither revoked nor expired.
   */
  // cm:guard read THIS and never `activeTokens > 0` at a call site: the server computes it from the same predicate the door verifies a token with, and a second derivation in the UI is how a screen starts saying an agent can act about a token the API turns away (ISS-1003 criterion 2).
  canAct: boolean;
}

/** `POST /api/orgs/:orgId/agents/:agentUserId/tokens`. Shown once and never read back. */
export interface AgentCredentialMinted {
  plaintext: string;
  boundProjectId: string;
}
