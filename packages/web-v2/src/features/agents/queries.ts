// The agents feature's reads: the runs read model's key factory and its queryOptions. Every key sits
// under `runs-standing`, so a write that moves a run invalidates them all (lib/ws/event-router.ts).
import { readOf } from "@/lib/api/query-kit";
import { runsApi } from "./api";
import type { RunStandingScope } from "./types";

const RUNS_POLL_MS = 20_000;

/** Every key the runs read model answers under; a write that moves a run invalidates it. */
export const RUNS_STANDING_ROOT = "runs-standing";

/** The support rooms' turns the project bar reads (REQ-15 BC-10); a frame that moves a room invalidates it. */
export const SUPPORT_TURNS_ROOT = "support-turns";

export const runKeys = {
  project: (projectId: string | undefined) => [RUNS_STANDING_ROOT, projectId] as const,
  standing: (projectId: string | undefined, scope: RunStandingScope) => [...runKeys.project(projectId), "list", scope] as const,
  run: (projectId: string | undefined, runId: string) => [...runKeys.project(projectId), "run", runId] as const,
  master: (projectId: string | undefined) => [...runKeys.project(projectId), "master"] as const,
  passes: (projectId: string | undefined) => [...runKeys.project(projectId), "passes"] as const,
  charter: (projectId: string | undefined) => [...runKeys.project(projectId), "charter"] as const,
  recent: (projectId: string | undefined) => [...runKeys.project(projectId), "recent"] as const,
  roomTurns: (projectId: string | undefined) => [SUPPORT_TURNS_ROOT, projectId] as const,
};

/** A runs read, polled: the read model moves without a frame for every change. */
const polled = <T>(key: readonly unknown[], fn: () => Promise<T>) => ({ ...readOf(key, fn), refetchInterval: RUNS_POLL_MS });

export const runQueries = {
  standing: (projectId: string | undefined, scope: RunStandingScope) => polled(runKeys.standing(projectId, scope), () => runsApi.standing(projectId as string, scope)),
  run: (projectId: string | undefined, runId: string) => polled(runKeys.run(projectId, runId), () => runsApi.run(projectId as string, runId)),
  master: (projectId: string | undefined) => polled(runKeys.master(projectId), () => runsApi.master(projectId as string)),
  passes: (projectId: string | undefined) => polled(runKeys.passes(projectId), () => runsApi.passes(projectId as string)),
  charter: (projectId: string | undefined, enabled: boolean) => ({ ...readOf(runKeys.charter(projectId), () => runsApi.charter(projectId as string)), enabled: enabled && !!projectId }),
};

/**
 * The project bar's reads (REQ-15 BC-10), never polled: each is read again when a project-room frame
 * says its source moved (`lib/ws/event-router.ts`). The live list shares the Agents list's key, so
 * either screen's read answers both.
 */
export const nowQueries = {
  live: (projectId: string | undefined) => readOf(runKeys.standing(projectId, "live"), () => runsApi.standing(projectId as string, "live")),
  recent: (projectId: string | undefined) => readOf(runKeys.recent(projectId), () => runsApi.recent(projectId as string)),
  rooms: (projectId: string | undefined) => readOf(runKeys.roomTurns(projectId), () => runsApi.roomTurns(projectId as string)),
};
