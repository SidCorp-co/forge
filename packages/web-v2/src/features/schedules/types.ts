// web-v2 feature module: schedules. Shapes verified against
// `packages/core/src/schedules/routes.ts` for ISS-299. The `/api/schedules`
// routes are user-token (JWT/cookie) auth — the browser `forge_auth` cookie is
// sent automatically, so no special handling vs other web-v2 features.
import type { StatusKey } from "@/design/status";

export type ScheduleLastStatus = "success" | "failed" | "running" | null;

export interface ScheduleRow {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  prompt: string;
  runner: string | null;
  enabled: boolean;
  targetProjectSlug: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: ScheduleLastStatus;
  lastSessionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Map a schedule's last run result to a design-kit StatusChip key. */
export function lastStatusToChip(status: ScheduleLastStatus): StatusKey | null {
  switch (status) {
    case "success":
      return "passed";
    case "failed":
      return "failed";
    case "running":
      return "running";
    default:
      return null;
  }
}

export type ScheduleRunTrigger = "manual" | "scheduled";

/** One past run of a schedule (an agent session under a system pipeline run).
 *  Shape verified against `GET /api/schedules/:id/runs` in
 *  `packages/core/src/schedules/routes.ts`. */
export interface ScheduleRun {
  sessionId: string;
  pipelineRunId: string | null;
  /** agent_session status: idle|queued|running|completed|failed|completed_via_recovery|cancelled_stale */
  status: string;
  runStatus: string | null;
  trigger: ScheduleRunTrigger;
  title: string | null;
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
}

/** Map an agent-session status to a design-kit StatusChip key (session domain). */
export function sessionStatusToChip(status: string): StatusKey {
  switch (status) {
    case "completed":
    case "completed_via_recovery":
      return "passed";
    case "failed":
    case "cancelled_stale":
      return "failed";
    case "running":
      return "running";
    default:
      return "queued";
  }
}
