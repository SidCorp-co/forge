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
