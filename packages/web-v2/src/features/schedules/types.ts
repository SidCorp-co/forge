export type ScheduleLastStatus = "success" | "failed" | "running" | "skipped" | null;

/** A schedule is either 'prompt' (existing agent-session behavior) or
 *  'script' (a standalone sandboxed Node.js script, no LLM/agent at all). */
export type ScheduleKind = "prompt" | "script";

export interface ScheduleRow {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  /** Nullable — a kind='script' row carries no prompt. */
  prompt: string | null;
  kind: ScheduleKind;
  script: string | null;
  enabled: boolean;
  targetProjectSlug: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: ScheduleLastStatus;
  lastSessionId: string | null;
  metadata: Record<string, unknown> | null;
  templateKey: string | null;
  params: Record<string, unknown> | null;
  mode: "propose" | "auto" | null;
  appliedMessageVersions: Record<string, number> | null;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleRunTrigger = "manual" | "scheduled";

export interface StewardRunReportAction {
  skill: string;
  kind: "proposed" | "applied" | "feedback" | "skipped";
  summary: string;
}

export interface StewardRunReportMemoryWrite {
  skill: string;
  sourceRef: string;
  tokensAfter: number;
}

export interface StewardRunReport {
  weakestDomain: string;
  skillsAssessed: string[];
  actions: StewardRunReportAction[];
  memoryWrites: StewardRunReportMemoryWrite[];
  idempotencySkips: string[];
}

export interface ScheduleRun {
  id: string;
  sessionId: string | null;
  pipelineRunId: string | null;
  status: string;
  fireStatus: "success" | "failed" | "running" | "skipped";
  runStatus: string | null;
  trigger: ScheduleRunTrigger;
  reason: string | null;
  refusal: string | null;
  disposition: string | null;
  title: string | null;
  failureReason: string | null;
  /** The specific cause behind `failureReason`; a refused run's code leads it (ISS-30). */
  failureDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  stewardReport: StewardRunReport | null;
  output: string | null;
  error: string | null;
}
