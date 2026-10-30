// What the schedules domain needs from the contexts after execution (notifications, release), handed
// in by the process entry at boot: a module imports only its own context or one before it
// (ADR 0008). Read only inside a call.

import type { NotificationType } from '../db/schema.js';
import { portSlot } from '../lib/port-slot.js';

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

/** What a cleanup window's fire does (`cleanup/fire.ts`, REQ-79 BC-7). */
export type CleanupFirePlan =
  | { kind: 'off'; why: string }
  | { kind: 'nothing'; why: string }
  | { kind: 'run'; prompt: string };

interface SchedulesPorts {
  /** Whether the project's cleanup run has anything to do, and its brief where it has. */
  cleanupFire(args: { projectId: string; fireId: string }): Promise<CleanupFirePlan>;
  emitNotification(input: ScheduleNotice): Promise<unknown>;
  /** The project's release gate and what waits at it; `gateStatus` is null with no gate. */
  loadReleaseRoster(projectId: string): Promise<{
    gateStatus: string | null;
    issues: { id: string; claimedByRunId: string | null }[];
  }>;
  /** The rows an aborted release left held for a person, which no unattended cut takes. */
  heldFromUnattendedCut(issueIds: readonly string[]): Promise<Set<string>>;
  createReleaseBatch(args: {
    projectId: string;
    issueIds: string[];
    userId: string;
  }): Promise<{ runId: string; issueIds: string[] }>;
  /** Store the period's report read as `viewerUserId` and tell each recipient once, in their language. */
  sendStatusReport(args: {
    projectId: string;
    scheduleId: string;
    viewerUserId: string;
    recipients: string[];
    days: number | undefined;
    /** A report template to run for the owner instead of reading the project status. */
    template?: { id: string; params: Record<string, string | number | boolean> | undefined };
    period: Date;
    timeZone: string | null;
    fireId: string;
  }): Promise<StatusReportSendOutcome>;
}

/** What one period of a `status_report` schedule came to (`status-reports/send.ts`). */
export type StatusReportSendOutcome =
  | { status: 'success'; reportId: string; told: number; output: string }
  | { status: 'refused'; code: string; detail: string };

const slot = portSlot<SchedulesPorts>('schedules', 'provideSchedulesPorts');
export const provideSchedulesPorts = slot.provide;
export const schedulesPorts = slot.get;
