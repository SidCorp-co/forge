// web-v2 feature module: automation → PM. Shapes mirror the backend Zod
// schemas in `packages/core/src/pm/routes.ts` (mounted at
// `/api/projects/:projectId/pm/*`) — that backend contract is the source of
// truth to keep these aligned with.

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
  eventTriggers: PmEventTriggers;
  customInstructions: string | null;
  modelOverride: string | null;
  maxRunsPerHour: number;
  createdAt: string;
  updatedAt: string;
}

export type PmConfigPatch = Partial<{
  enabled: boolean;
  eventTriggers: PmEventTriggers;
  customInstructions: string | null;
  modelOverride: string | null;
  maxRunsPerHour: number;
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

export const PM_TRIGGER_LABELS: Record<keyof PmEventTriggers, string> = {
  jobFailed: "Job failed",
  pipelineStalled: "Pipeline stalled",
  needsInfo: "Issue needs info",
  queuePressure: "Queue pressure",
  graphChanged: "Knowledge graph changed",
};

export const PM_MODEL_OPTIONS: { label: string; value: string }[] = [
  { label: "Default (app config)", value: "" },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

export type {
  AutomationStandingResponse,
  AutomationWaitingOn,
  FireDetailResponse,
  FireProduced,
  FireProposal,
  FireStanding,
  ReportDetailResponse,
  ReportStanding,
  ScheduleDetailResponse,
  ScheduleStanding,
  ScheduleState,
} from "@forge/contracts/automation-standing";
export type { ScheduleKind, ScheduleRunStatus, ScheduleRunTrigger } from "@forge/contracts/schedules";
