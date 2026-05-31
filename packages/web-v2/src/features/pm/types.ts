// web-v2 feature module: pm (project-manager agent). Types mirror the EXACT
// shapes from core (verified ISS-296):
//   • PM:        `packages/core/src/pm/routes.ts`
//   • deps:      `packages/core/src/issues/dependency-routes.ts`
//   • dispatch:  `packages/core/src/issues/extras-routes.ts` (run-pipeline-step)
//   • issues:    `packages/core/src/issues/routes.ts` (serializeIssue)
//
// NOTE (ISS-296 API-surface finding): PM graph / snapshot / runner-load /
// dispatch / write-decision have NO REST routes (MCP-only). The screen derives
// those views client-side from real REST: the dependency edges, the project
// health rollup, and `GET /api/runners?projectId`.

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

export interface PmConfigPatch {
  enabled?: boolean;
  cadenceCron?: string | null;
  eventTriggers?: PmEventTriggers;
  customInstructions?: string | null;
  modelOverride?: string | null;
  maxRunsPerHour?: number;
}

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

export type PmPolicyPatch = Partial<PmPolicyCreate>;

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

export type DependencyKind = "blocks" | "relates" | "duplicates" | "parent" | "decomposes";

/** A row of `issue_dependencies`. */
export interface IssueDependency {
  id: string;
  projectId: string;
  fromIssueId: string;
  toIssueId: string;
  kind: DependencyKind;
  reason: string | null;
  createdById: string | null;
  createdAt: string;
  validUntil: string | null;
}

/** `GET /api/issues/:id/dependencies` → outgoing + incoming edges. */
export interface DependenciesResponse {
  outgoing: IssueDependency[];
  incoming: IssueDependency[];
}

/** Minimal issue projection for the dependency picker (serializeIssue subset). */
export interface IssueLite {
  id: string;
  documentId: string;
  displayId: string;
  title: string;
  status: string;
}

/** `POST /api/issues/:id/run-pipeline-step` (202) response. */
export interface RunPipelineStepResult {
  issueId: string;
  jobId: string;
  stage: string;
  status: "queued";
}

export type PipelineStage =
  | "triage"
  | "clarify"
  | "plan"
  | "code"
  | "review"
  | "test"
  | "fix"
  | "release";
