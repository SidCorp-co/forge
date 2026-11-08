// What the schedules domain needs from the contexts after execution (notifications, release), handed
// in by the process entry at boot: a module imports only its own context or one before it
// (ADR 0008). Read only inside a call.

import type { ReleaseNaming } from '@forge/contracts/release-notes';
import type { ReleaseCutAs } from '@forge/contracts/releases';
import type { SupportReadSecret } from '@forge/contracts/support';
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
  /** Nothing else is owed and what landed since the last report cannot be read (ISS-1050). */
  | { kind: 'unread'; why: string }
  | { kind: 'run'; prompt: string };

/** A script schedule's filing, checked against its shape (`script-feedback.ts`). */
interface ScriptFilingAsk {
  projectId: string;
  schedule: { id: string; name: string };
  fireId: string;
  request: {
    kind: 'bug' | 'change_request' | 'question' | 'idea';
    title: string;
    body?: string | undefined;
    severity?: 'low' | 'medium' | 'high' | 'critical' | undefined;
    signalKey: string;
  };
}

/** A declared read refused: each detail names what could not stand (`support/outcome.ts:Outcome`). */
type ReadRefused = { ok: false; refusals: readonly { detail: string }[] };

interface SchedulesPorts {
  /** Whether a command a forge-ops `exec_command` runs only reads (support's classifier, REQ-75 r5 BC-27). */
  commandReads(command: string): { reads: true } | { reads: false; why: string };
  /**
   * A script's ops call takes its credential and box by support's one declared-read path
   * (`support/declared-read.ts`, ISS-707): each declared secret's value, or the refusal naming the
   * ones the vault does not hold; the project's box that runs a declared read; and a text cut of
   * every handed secret's value.
   */
  secretEnvOf(
    projectId: string,
    name: string,
    secrets: readonly SupportReadSecret[] | undefined,
  ): Promise<{ ok: true; env: Record<string, string> } | ReadRefused>;
  projectReadBox(projectId: string): Promise<{ ok: true; value: string } | ReadRefused>;
  withoutSecrets(text: string, env: Record<string, string>): string;
  /**
   * File a script schedule's feedback on its own project as the project's own agent, joined by its
   * signal key (REQ-87 BC-2): the item's key, and whether it was filed new or joined.
   */
  fileScriptFeedback(
    ask: ScriptFilingAsk,
  ): Promise<{ ok: true; key: string; created: boolean } | { ok: false; why: string }>;
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
    /** `automatic` where no person's act cuts it, so it never reads as `userId`'s cut (ISS-1153). */
    cutAs?: ReleaseCutAs;
    /** The release's name and summary, where the cut writes them (the beta port's, ISS-988). */
    naming?: ReleaseNaming;
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
