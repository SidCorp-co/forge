/**
 * Shapes mirror backend Zod schemas in `packages/core/src/pm/routes.ts`.
 * `packages/web/src/features/pm/types.ts` must stay byte-equivalent for the
 * shared interfaces — see `jarvis-agents/CLAUDE.md` cross-app-parity.
 */

export interface PmEventTriggers {
  jobFailed: boolean;
  pipelineStalled: boolean;
  needsInfo: boolean;
  queuePressure: boolean;
  graphChanged: boolean;
}

export interface PmConfig {
  id: string;
  projectId: string;
  enabled: boolean;
  cadenceCron: string | null;
  eventTriggers: PmEventTriggers;
  customInstructions: string | null;
  modelOverride: string | null;
  maxRunsPerHour: number;
  createdAt: string;
  updatedAt: string;
}

export type PmConfigPatch = Partial<{
  enabled: boolean;
  cadenceCron: string | null;
  eventTriggers: PmEventTriggers;
  customInstructions: string | null;
  modelOverride: string | null;
  maxRunsPerHour: number;
}>;

export interface PmPolicy {
  id: string;
  projectId: string;
  name: string;
  body: string;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface PmPolicyCreate {
  name: string;
  body: string;
  enabled?: boolean;
  priority?: number;
}

export type PmPolicyPatch = Partial<{
  name: string;
  body: string;
  enabled: boolean;
  priority: number;
}>;

export interface PmDecision {
  id: string;
  projectId: string;
  cause: string;
  summary: string;
  actions: unknown[];
  confidence: number | null;
  modelTier: string | null;
  tookMs: number | null;
  createdAt: string;
}

export interface PmEscalationOption {
  id: string;
  label: string;
}

/**
 * Decoded payload of a `pm_escalation` notification's `body` field.
 * `forge_pm.escalate` writes this as a JSON string — see
 * `packages/core/src/mcp/tools/forge-pm-escalate.ts`.
 */
export interface PmEscalationPayload {
  decisionId: string;
  severity: "low" | "medium" | "high" | "critical";
  question: string;
  options: PmEscalationOption[];
  expiresAt: string;
}

export interface PmEscalationRespond {
  optionId: string;
  comment?: string;
}
