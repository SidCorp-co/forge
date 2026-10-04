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
  metadata: Record<string, unknown> | null;
  templateKey: string | null;
  params: Record<string, unknown> | null;
  mode: "propose" | "auto" | null;
  appliedMessageVersions: Record<string, number> | null;
  createdAt: string;
  updatedAt: string;
}
