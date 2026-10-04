import type { SessionAsker, SessionRefusal } from '../agent-sessions/index.js';
import type { ScheduleKind } from '../db/schema.js';
import type { FireSettlement } from './fires.js';

export interface ScheduleRowForDispatch {
  id: string;
  name?: string | null;
  projectId: string;
  prompt: string | null;
  targetProjectSlug: string | null;
  params?: Record<string, unknown> | null;
  /** `'script'` runs a sandboxed script with no agent session at all (ISS-618). */
  kind?: ScheduleKind | null;
  script?: string | null;
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

type RoutedScheduleResult =
  | {
      ok: true;
      sessionId: string | null;
      status: 'running' | 'success' | 'skipped';
      resolvedProjectId: string;
    }
  | {
      ok: false;
      reason: 'project-not-found' | 'no-device';
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

export type DispatchScheduleResult = RoutedScheduleResult & { fireId: string };

export interface RoutedFire {
  result: RoutedScheduleResult;
  settle: FireSettlement | null;
}
