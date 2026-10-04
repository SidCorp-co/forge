// What the schedules domain needs from the contexts after execution (notifications, release), handed
// in by the process entry at boot: a module imports only its own context or one before it
// (ADR 0008). Read only inside a call.

import type { NotificationType } from '../db/schema.js';

/** One notification a schedule raises for a person. */
interface ScheduleNotice {
  userId: string;
  projectId: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  severity?: string | null;
  agentSessionId?: string | null;
  scheduleRunId?: string | null;
}

interface SchedulesPorts {
  emitNotification(input: ScheduleNotice): Promise<unknown>;
  /** The project's release gate and what waits at it; `gateStatus` is null with no gate. */
  loadReleaseRoster(projectId: string): Promise<{
    gateStatus: string | null;
    issues: { id: string; claimedByRunId: string | null }[];
  }>;
  createReleaseBatch(args: {
    projectId: string;
    issueIds: string[];
    userId: string;
  }): Promise<{ runId: string; issueIds: string[] }>;
}

let provided: SchedulesPorts | null = null;

export function provideSchedulesPorts(ports: SchedulesPorts): void {
  provided = ports;
}

export function schedulesPorts(): SchedulesPorts {
  if (!provided) {
    throw new Error(
      'schedules: no ports were provided, so a schedule cannot notify or cut a release; the process entry calls provideSchedulesPorts before it serves',
    );
  }
  return provided;
}
