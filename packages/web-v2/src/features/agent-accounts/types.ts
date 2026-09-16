export type { AgentSelf, AgentSelfPatch, PresenceConfig } from "@forge/contracts";

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
   * Whether this agent holds a live credential AND a project for it to act on.
   * Both halves: the token is fenced to one project and the membership is what
   * answers on the other side, so either one missing means it can act nowhere.
   */
  canAct: boolean;
}

/** `POST /api/orgs/:orgId/agents/:agentUserId/tokens`. Shown once and never read back. */
export interface AgentCredentialMinted {
  plaintext: string;
  boundProjectId: string;
}
