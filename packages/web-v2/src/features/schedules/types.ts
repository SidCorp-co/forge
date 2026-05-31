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
