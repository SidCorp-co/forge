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
  NO_OP: 'Already in that state.',
  NOT_IMPLEMENTED: 'This action is not implemented yet.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  SLUG_TAKEN: 'That slug is already taken.',
  ASSIGNEE_NOT_MEMBER: 'Assignee must be a project member.',
  INVALID_LABELS: 'One or more labels do not belong to this project.',
  LABEL_NAME_TAKEN: 'A label with that name already exists in this project.',
  LABEL_IN_USE: 'Issues are still tagged with this — remove it from them first.',
  INVALID_PARENT: 'That parent is not a label in this project.',
  PARENT_NOT_MODULE: 'A module’s parent has to be a module.',
  PARENT_ON_NON_MODULE: 'Only a module can have a parent.',
  CIRCULAR_HIERARCHY: 'That parent sits under this module — pick one above it.',
  MODULE_IN_USE: 'Other modules or issues still depend on this one.',
  PRIMARY_NOT_MODULE: 'Only a module can be an issue’s primary.',
  MULTIPLE_PRIMARY: 'An issue has at most one primary module.',
  NO_MODULES: 'This project has no modules yet — create one to draw its diagrams.',
  NO_MODULE_FLOWS: 'No module stores a flow yet — add a mermaid block to a module’s knowledge node.',
  UNPARSABLE_MODULE_FLOW: 'A module stores a flow this generator cannot read.',
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
  awaiting_release: 'Auto release',
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
const ZOD_REFUSAL_KEYS = ['poolBacklog', 'intakeGate', 'mcpServers', 'states'];

function zodRefusal(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object') return null;
  for (const key of ZOD_REFUSAL_KEYS) {
    const msgs = (fieldErrors as Record<string, unknown>)[key];
    if (Array.isArray(msgs) && typeof msgs[0] === 'string') return msgs[0];
  }
  return null;
}

export function formatPipelineConfigError(err: unknown): string {
  if (!(err instanceof ApiError)) return formatApiError(err);

  if (err.code === 'BAD_REQUEST') {
    const refusal = zodRefusal(err.details);
    if (refusal) return refusal;
  }

  switch (err.code) {
    case 'CONFIG_STALE':
      return formatSettingsWriteError(err);
    case 'CONFIG_CONFLICT':
      return err.message;
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


// ─── A save refused because the document moved under it ──────────────────────
//
// `CONFIG_STALE` / `ENVIRONMENTS_STALE` carry `details.conflicts`: one row per path the
// write named, with the value the caller read and the value stored now. The person is owed
// three things from that (ISS-1170): WHICH settings changed under them, that NOTHING was
// written, and the re-read that makes the save possible.

interface WriteConflict {
  path: string;
  base: unknown;
  stored: unknown;
}

/** Dotted paths, as the settings screen labels them. Longest prefix wins. */
const SETTING_LABELS: [prefix: string, label: string][] = [
  ['states.', 'Stage settings'],
  ['intakeGate', 'Intake gate'],
  ['poolBacklog', 'Master backlog'],
  ['knowledgePromotion', 'Knowledge promotion'],
  ['assistantWeekly', 'Assistant weekly reading'],
  ['mcpServers', 'MCP servers'],
  ['plugins', 'Plugins'],
  ['enabled', 'Pipeline enabled'],
  ['live', 'Live'],
  ['preview', 'Preview'],
  ['testCredentials', 'Test credentials'],
  ['limits', 'Limits'],
];

const STAGE_SETTING_LABELS: Record<string, string> = {
  deviceIds: 'Runner pools',
  allowedTools: 'Stage permissions',
  disallowedTools: 'Stage permissions',
  mcpServers: 'Stage permissions',
};

/** A stage as the SETTINGS rows name it, which is not what the auto-stage toggles are
 *  called: mirrors `PIPELINE_STATUS_ROWS` in `features/project-settings/types.ts`. */
const SETTINGS_STAGE_LABELS: Record<string, string> = {
  open: 'Queued',
  in_progress: 'Running',
  needs_info: 'Needs a human',
  awaiting_release: 'Awaiting release',
};

/** `states.open.deviceIds` → "Runner pools (Queued)"; `intakeGate.enabled` → "Intake gate". */
export function settingLabel(path: string): string {
  const parts = path.split('.');
  if (parts[0] === 'states' && parts.length >= 3) {
    const leaf = STAGE_SETTING_LABELS[parts[2]] ?? 'Stage settings';
    return `${leaf} (${SETTINGS_STAGE_LABELS[parts[1]] ?? parts[1]})`;
  }
  for (const [prefix, label] of SETTING_LABELS) {
    if (path === prefix || path.startsWith(prefix)) return label;
  }
  return path;
}

export function writeConflicts(err: unknown): WriteConflict[] {
  if (!(err instanceof ApiError)) return [];
  if (err.code !== 'CONFIG_STALE' && err.code !== 'ENVIRONMENTS_STALE') return [];
  const rows = (err.details as { conflicts?: unknown } | undefined)?.conflicts;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is WriteConflict =>
      typeof row === 'object' && row !== null && typeof (row as WriteConflict).path === 'string',
  );
}

function listOf(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? 'These settings';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** Dotted document paths as one phrase in the screen's own names, for a sentence about them. */
export function settingsThatMoved(paths: string[]): string {
  return listOf(paths.map(settingLabel));
}

/**
 * What a refused settings save reads as on screen: the settings that moved, in the
 * screen's own names, and that nothing was written. The re-read is an action beside this
 * sentence rather than an instruction inside it.
 */
export function formatSettingsWriteError(err: unknown): string {
  const conflicts = writeConflicts(err);
  if (conflicts.length === 0) return formatApiError(err);
  const names = settingsThatMoved(conflicts.map((c) => c.path));
  const changed = conflicts.length === 1 ? 'was changed' : 'were changed';
  return `${names} ${changed} by someone else while this page was open. Nothing was saved — your edits are still here.`;
}
