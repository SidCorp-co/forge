// The dispatch contract, with no implementation attached.
//
// Split out so the runner-less branches (script, release_batch) can take the
// same input and return the same result without importing the module that
// calls them.

import type { ScheduleKind, ScheduleMode } from '../db/schema.js';
import type { AppliedVersions } from './messages/skill-improve-prompt.js';

export interface ScheduleRowForDispatch {
  id: string;
  name?: string | null;
  projectId: string;
  /** Null for `kind='script'` — a script schedule carries no prompt at all (ISS-618). */
  prompt: string | null;
  runner: 'desktop' | 'antigravity';
  targetProjectSlug: string | null;
  /** When set, the skill-improve engine builds the prompt instead of using `prompt`. */
  templateKey?: string | null;
  params?: Record<string, unknown> | null;
  mode?: ScheduleMode | null;
  appliedMessageVersions?: AppliedVersions | null;
  /** `'script'` runs a sandboxed script with no agent session at all (ISS-618). */
  kind?: ScheduleKind | null;
  script?: string | null;
}

export interface DispatchScheduleInput {
  schedule: ScheduleRowForDispatch;
  /**
   * Manual triggers attribute the session to the calling user; tick triggers fall back to the
   * resolved project's creator. `agent_sessions.user_id` is nullable, but populating it is what
   * makes the audit trail and activity feed name someone.
   */
  actorUserId?: string;
  /** Marks the session metadata so consumers can tell tick-driven runs from manual `/:id/run`. */
  tick?: boolean;
  /** Set when the caller already resolved `targetProjectSlug` (e.g. the route's auth gate), to skip a redundant lookup. */
  resolvedTarget?: { id: string; createdBy: string };
}

export type DispatchScheduleResult =
  // cm:why 'running' (interactive session path, decided later by the session's own lifecycle -> writeBackScheduleLastStatus) vs 'success' (script path, already ran synchronously in dispatchScheduleScriptRun) — the caller never re-derives which
  | { ok: true; sessionId: string; status: 'running' | 'success'; resolvedProjectId: string }
  | {
      ok: false;
      reason: 'project-not-found' | 'no-device' | 'unsupported-runner' | 'already-applied';
      status: 'skipped';
    }
  | { ok: false; reason: 'session-failed'; status: 'failed'; sessionId?: string };
