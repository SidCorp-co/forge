// web-v2 feature module: automation → PM. Shapes mirror the backend Zod
// schemas in `packages/core/src/pm/routes.ts` (mounted at
// `/api/projects/:projectId/pm/*`). Kept aligned with the v1 source of truth
// `packages/web/src/features/pm/types.ts`.

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

export const PM_CRON_PRESETS: { label: string; value: string | null }[] = [
  { label: "Off", value: null },
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Every 6h", value: "0 */6 * * *" },
];

export const PM_MODEL_OPTIONS: { label: string; value: string }[] = [
  { label: "Default (app config)", value: "" },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];
