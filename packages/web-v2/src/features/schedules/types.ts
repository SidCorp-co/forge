// web-v2 feature module: schedules. Shapes verified against
// `packages/core/src/schedules/routes.ts` for ISS-299. The `/api/schedules`
// routes are user-token (JWT/cookie) auth — the browser `forge_auth` cookie is
// sent automatically, so no special handling vs other web-v2 features.
import type { StatusKey } from "@/design/status";

export type ScheduleLastStatus = "success" | "failed" | "running" | null;

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
  runner: string | null;
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
  stewardReport: StewardRunReport | null;
  /** script-kind runs only: captured console output + failure message. */
  output?: string | null;
  error?: string | null;
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
