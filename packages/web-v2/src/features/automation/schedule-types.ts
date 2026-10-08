import type { ScheduleKind, ScheduleRunStatus } from "@forge/contracts/schedules";

export type { ScheduleKind } from "@forge/contracts/schedules";
export type ScheduleLastStatus = ScheduleRunStatus | null;

export interface ScheduleRow {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  prompt: string | null;
  kind: ScheduleKind;
  script: string | null;
  enabled: boolean;
  targetProjectSlug: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: ScheduleLastStatus;
  lastSessionId: string | null;
  params: Record<string, unknown> | null;
  /** The IANA zone the cron is read in; null reads it in UTC. */
  timeZone: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The fields a create or an edit sends; a release_batch, sentry_pull or status_report schedule carries no prompt or script. */
export interface ScheduleInput {
  name: string;
  cron: string;
  kind: ScheduleKind;
  prompt?: string;
  script?: string;
  enabled?: boolean;
  targetProjectSlug?: string | null;
  /** A status_report schedule's recipients and window (`@forge/contracts/status-reports:StatusReportScheduleParams`). */
  params?: Record<string, unknown> | null;
  timeZone?: string | null;
}
