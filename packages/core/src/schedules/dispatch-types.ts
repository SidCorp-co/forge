import type { SessionRefusal } from '../agent-sessions/interactive-credential.js';
import type { SessionAsker } from '../agent-sessions/session-credential.js';
import type { ScheduleKind, ScheduleMode } from '../db/schema.js';
import type { AppliedVersions } from './messages/skill-improve-prompt.js';

export interface ScheduleRowForDispatch {
  id: string;
  name?: string | null;
  projectId: string;
  prompt: string | null;
  targetProjectSlug: string | null;
  /** When set, the skill-improve engine builds the prompt instead of using `prompt`. */
  templateKey?: string | null;
  params?: Record<string, unknown> | null;
  mode?: ScheduleMode | null;
  appliedMessageVersions?: AppliedVersions | null;
  /** `'script'` runs a sandboxed script with no agent session at all (ISS-618). */
  kind?: ScheduleKind | null;
  script?: string | null;
  /** Who a cron firing of a prompt-kind schedule acts as; null once that account is gone. */
  ownerId: string | null;
}

export interface DispatchScheduleInput {
  schedule: ScheduleRowForDispatch;
  /** The person who pressed run, and the token they pressed it with; absent on a cron firing. */
  actor?: SessionAsker;
  /** Marks the session metadata so consumers can tell tick-driven runs from manual `/:id/run`. */
  tick?: boolean;
  /** Set when the caller already resolved `targetProjectSlug` (e.g. the route's auth gate), to skip a redundant lookup. */
  resolvedTarget?: { id: string; createdBy: string };
}

export type DispatchScheduleResult =
  | { ok: true; sessionId: string; status: 'running' | 'success'; resolvedProjectId: string }
  | {
      ok: false;
      reason: 'project-not-found' | 'no-device' | 'already-applied';
      status: 'skipped';
    }
  | { ok: false; reason: 'session-failed'; status: 'failed'; sessionId?: string }
  | {
      ok: false;
      reason: 'refused';
      status: 'failed';
      sessionId: string;
      refusal: SessionRefusal;
    };
