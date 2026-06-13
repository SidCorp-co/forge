// Ported verbatim from `packages/web/src/lib/api/error.ts` (ISS-288).
import { ApiError } from './client';

const FRIENDLY_CODES: Record<string, string> = {
  UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
  INVALID_TOKEN: 'Your session is invalid. Please sign in again.',
  FORBIDDEN: 'You do not have access to this resource.',
  ADMIN_ONLY: 'Admin access required.',
  EMAIL_NOT_VERIFIED: 'Please verify your email before continuing.',
  NOT_FOUND: 'Not found.',
  BAD_REQUEST: 'Invalid input — please check the fields and try again.',
  CONFLICT: 'Conflicts with the current state of the resource.',
  ILLEGAL_TRANSITION: 'That status change is not allowed from the current state.',
  STALE_TRANSITION: 'Someone else changed this item while you were editing — refresh and retry.',
  REOPEN_CAP_EXCEEDED: 'Reopen limit reached for this issue.',
  NO_OP: 'Already in that state.',
  NOT_IMPLEMENTED: 'This action is not implemented yet.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  SLUG_TAKEN: 'That slug is already taken.',
  ASSIGNEE_NOT_MEMBER: 'Assignee must be a project member.',
  INVALID_LABELS: 'One or more labels do not belong to this project.',
};

export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code && FRIENDLY_CODES[err.code]) return FRIENDLY_CODES[err.code];
    if (err.message) return err.message;
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

// ─── Pipeline-config errors (ISS-422) ───────────────────────────────────────
//
// `PATCH /api/projects/:id/pipeline-config` rejects with a typed `code` and a
// structured `details` payload (e.g. which stages are missing a skill). The
// generic `formatApiError` only ever returns `err.message`, so the actionable
// detail — *which* stage blocked the save — was dropped, leaving the user with
// a vague toast. `formatPipelineConfigError` reads `ApiError.details` for the
// known pipeline-config codes and builds a stage-naming, actionable message.
// These codes are intentionally NOT added to `FRIENDLY_CODES`: that map is a
// static code→string lookup and cannot read `details`.

/**
 * Map a pipeline stage *status* (as it appears in error `details`) to the
 * human-facing auto-stage toggle label shown in the Pipeline settings tab.
 * Mirrors `STEP_TOGGLE_LABELS` in `features/project-settings/types.ts`.
 * Any status outside the 8 toggle stages (STAGE_HAS_ISSUES / DEAD_END_CONFIG
 * can reference others) falls back to its raw status name.
 */
const STAGE_LABELS: Record<string, string> = {
  open: 'Auto triage',
  confirmed: 'Auto clarify',
  clarified: 'Auto plan',
  approved: 'Auto code',
  developed: 'Auto review',
  testing: 'Auto test',
  reopen: 'Auto fix',
  released: 'Auto release',
};

function stageLabel(status: string): string {
  return STAGE_LABELS[status] ?? status;
}

/** Read a `string[]` field from the untyped `details` blob, defensively. */
function detailStringList(details: unknown, key: string): string[] {
  if (details && typeof details === 'object') {
    const value = (details as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}

function joinStageLabels(statuses: string[]): string {
  return statuses.map(stageLabel).join(', ');
}

/**
 * Format a pipeline-config save rejection into a clear, actionable, stage-naming
 * message. Falls back to {@link formatApiError} for non-ApiError values and any
 * code without a dedicated message (so behaviour never regresses).
 */
export function formatPipelineConfigError(err: unknown): string {
  if (!(err instanceof ApiError)) return formatApiError(err);

  switch (err.code) {
    case 'MISSING_SKILL_FOR_ENABLED_STAGE':
    case 'AUTO_STAGE_NEEDS_SKILL': {
      const stages = detailStringList(err.details, 'stagesMissingSkill');
      if (stages.length === 0) break;
      const labels = joinStageLabels(stages);
      return `Can't save: ${labels} ${stages.length === 1 ? 'needs' : 'need'} a registered skill before ${stages.length === 1 ? 'it' : 'they'} can run automatically. Register a skill for ${stages.length === 1 ? 'that stage' : 'those stages'} (Library) or turn the toggle off.`;
    }
    case 'STAGE_HAS_ISSUES': {
      const stages = detailStringList(err.details, 'stagesBlocked');
      const blocking = detailStringList(err.details, 'blockingIssueIds');
      if (stages.length === 0) break;
      const labels = joinStageLabels(stages);
      const count = blocking.length;
      const issuesPhrase = count > 0 ? `${count} issue${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} currently at ${count === 1 ? 'that stage' : 'those stages'}` : 'issues are currently at those stages';
      return `Can't disable ${labels}: ${issuesPhrase}. Move or close them first.`;
    }
    case 'DEAD_END_CONFIG': {
      const stages = detailStringList(err.details, 'unreachable');
      if (stages.length === 0) break;
      const labels = joinStageLabels(stages);
      return `These stages would have no forward path: ${labels}. Re-enable one of them or an earlier stage.`;
    }
    case 'OPEN_LOCKED_ON':
      return "The Open stage can't be disabled.";
  }

  return formatApiError(err);
}
