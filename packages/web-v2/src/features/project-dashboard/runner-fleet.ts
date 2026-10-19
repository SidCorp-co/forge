// The project's runners, read once for the dashboard and the sessions page's box strip (ISS-1228).

import { useNow } from "@/design";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import type { SessionsAndHolds } from "@/features/pipeline/types";
import { useActiveRunners, useProjectRunners } from "@/features/runners/hooks";
import { useQueueStats } from "@/features/sessions/hooks";
import { type RunnersSummary, runnersSummary } from "./derive";
import { type ReadState, readOf, readOfAll } from "./shape";

export interface RunnerFleet {
  summary: RunnersSummary;
  runners: ReadState;
  queue: ReadState;
  /** The queue, active-runner and live-session reads: until all are in, no runner is called busy or free. */
  activity: ReadState;
}

/** Every live session a box holds, of any kind: the sessions the Pipeline page lists, and the chats
 *  whose turn is running, which it does not list (ISS-1228). */
function boxSessions(read: SessionsAndHolds | undefined): Array<{ deviceId: string | null }> | undefined {
  return read ? [...read.sessions, ...read.runningChats] : undefined;
}

/** A core older than the running-chat count answers without it: its boxes are then called neither
 *  busy nor free, rather than free while a chat runs on them. */
const NO_CHAT_COUNT: ReadState = {
  read: "failed",
  reason: "core answered no running chats, so no box's sessions can be counted",
};

function activityOf(...reads: Parameters<typeof readOfAll>): ReadState {
  const state = readOfAll(...reads);
  const sessions = reads[2]?.data as SessionsAndHolds | undefined;
  return state.read === "ok" && !Array.isArray(sessions?.runningChats) ? NO_CHAT_COUNT : state;
}

/** A runner hosting a live session is busy; one under a limit ticks each second so its countdown reads true. */
export function useRunnerFleet(projectId: string | undefined, now: number): RunnerFleet {
  const projectRunnersQ = useProjectRunners(projectId ?? null);
  const queueQ = useQueueStats(projectId);
  const activeRunnersQ = useActiveRunners(projectId ?? null);
  const sessionsQ = useSessionsAndHolds(projectId);
  const anyLimited = (projectRunnersQ.data ?? []).some((r) => r.limitReason);
  const tick = useNow(1000, anyLimited);
  const activity = activityOf(queueQ, activeRunnersQ, sessionsQ);
  const heard = activity.read === "ok";
  const queue = readOf(queueQ);
  return {
    summary: runnersSummary(
      projectRunnersQ.data,
      queue.read === "ok" ? queueQ.data : undefined,
      anyLimited ? tick : now,
      heard ? activeRunnersQ.data?.runners : undefined,
      heard ? boxSessions(sessionsQ.data) : undefined,
    ),
    runners: readOf(projectRunnersQ),
    queue,
    activity,
  };
}
