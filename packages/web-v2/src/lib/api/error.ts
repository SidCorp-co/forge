import { parsePath } from '@forge/contracts/document-patch';
import { ISSUE_STATUS_LABELS } from '@forge/contracts/issue-vocabulary';
import { claimConflictSentence } from './claim-conflict';
import { ApiError, isReasonPhrase, unsaidFailure } from './client';

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

/** ISS-1160 — a screen offers Retry only where retrying could change the answer.
 *  A 4xx is the same request meeting the same refusal again; only a network
 *  failure or a 5xx is worth resubmitting. */
export function isRetryableApiError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500;
  return true;
}

/**
 * ISS-1327 — the merge-mark refusals in the web's own words. Core's sentence is written for
 * agents and names every door there is; a person here has one, the issue's Mark merged control.
 * Read off `details`, never parsed out of the prose.
 */
function detailStr(details: unknown, key: string): string | null {
  const value = details && typeof details === 'object' ? (details as Record<string, unknown>)[key] : null;
  return typeof value === 'string' ? value : null;
}

function mergeMarkSentence(err: ApiError): string | null {
  if (err.code === 'CLOSE_REQUIRES_SHIPPED') {
    if (detailStr(err.details, 'requires') !== 'mergedLanding') {
      return 'Nothing on this issue says the work shipped, so it cannot close. Once it has, use Mark merged in the issue’s properties, then close. Use Dropped for work that turned out not to be work.';
    }
    const unmarkFirst =
      detailStr(err.details, 'held') === 'asserted'
        ? 'Its mark names no landing, so press Unmark first, then '
        : 'Use ';
    return `Nothing on this issue says where the work landed, so it cannot close. ${unmarkFirst}Mark merged in the issue’s properties and fill in “Where it landed” — the live URL, CMS entry or storefront resource — then close. Use Dropped if it never landed.`;
  }
  if (err.code === 'MARK_ALREADY_STANDS') {
    const held = detailStr(err.details, 'heldLanding');
    const stands = held ? `This issue’s mark already says it landed at ${held}` : 'This issue already carries a mark that names no landing';
    return `${stands}, and that mark stands — nothing changed. To change it, press Unmark, then Mark merged with the landing that is right.`;
  }
  return null;
}

/** The issue page's row a person sets an issue's own landing shape on; refusals point at it by name. */
export const LANDING_SHAPE_ROW = 'Work lands';

/**
 * The two project writes refused for the work they would strand, in the web's own words. Core's
 * sentence is written for agents, with its code, field names and API routes; a person here acts on
 * the issues the banner links, so the steps are the controls those issues carry.
 */
function strandedWorkSentence(err: ApiError): string | null {
  if (err.code !== 'RELEASE_CHAIN_STRANDS_WORK' && err.code !== 'PROJECT_KIND_STRANDS_WORK') return null;
  const total = (err.details as { total?: unknown } | undefined)?.total;
  if (typeof total !== 'number' || total < 1) return null;
  const one = total === 1;
  const it = one ? 'it' : 'them';
  if (err.code === 'RELEASE_CHAIN_STRANDS_WORK') {
    return (
      `${total} ${one ? 'issue waits' : 'issues wait'} at ${ISSUE_STATUS_LABELS.awaiting_release}, and with no release path nothing would ever release ${it}. ` +
      `Release ${it} first, or return ${one ? 'it' : 'each one'} to ${ISSUE_STATUS_LABELS.developed}, then save again. ` +
      `Closing ${it} is not a way out: a close says the work shipped.`
    );
  }
  const outsideGit = detailStr(err.details, 'to') === 'website';
  const kept = detailStr(err.details, 'landingShape') === 'outside_git' ? 'Outside git' : 'In git';
  return (
    `${total} open ${one ? 'issue carries a merge mark' : 'issues carry merge marks'} that would stop counting as a landing once this project ${outsideGit ? 'has no repository' : 'has a repository'}. ` +
    `Finish ${it} first, then change the shape. Or keep ${one ? 'its mark' : 'their marks'} counting: on ${one ? 'the issue' : 'each issue'}, press Unmark, set ${LANDING_SHAPE_ROW} to “${kept}”, ` +
    `and mark ${one ? 'it' : 'each one'} merged again; then change the shape.`
  );
}

/** A landing shape refused because a merge mark stands: the mark is judged on the lane it was made under. */
function landingShapeSentence(err: ApiError): string | null {
  if (err.code !== 'LANDING_SHAPE_MARK_STANDS') return null;
  return (
    'Nothing changed: this issue carries a merge mark, and a mark is judged on where its work landed when it was made. ' +
    `Press Unmark, set ${LANDING_SHAPE_ROW} again, then mark it merged again.`
  );
}

export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const worded = mergeMarkSentence(err) ?? strandedWorkSentence(err) ?? landingShapeSentence(err);
    if (worded) return worded;
    const claimed = err.code === 'CLAIM_CONFLICT' ? claimConflictSentence(err.details) : null;
    if (claimed) return claimed;
    if (err.code && FRIENDLY_CODES[err.code]) return FRIENDLY_CODES[err.code];
    if (!err.message.trim() || isReasonPhrase(err.message)) return unsaidFailure(err.status);
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/** A failure as a sentence of its own, so what a message says next starts after a full stop. */
export function formatApiReason(err: unknown): string {
  const text = formatApiError(err).trim();
  const opened = /^[a-z]/.test(text) ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}


/**
 * A stage named in a save refusal's `details` is named by its status's own word, the one every
 * screen reads (`ISSUE_STATUS_LABELS`). A status the vocabulary does not hold keeps its raw name.
 */
function stageLabel(status: string): string {
  return (ISSUE_STATUS_LABELS as Record<string, string>)[status] ?? status;
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
      return `Can't save: ${labels} ${stages.length === 1 ? 'needs' : 'need'} a registered skill before ${stages.length === 1 ? 'it' : 'they'} can run automatically. Register a skill for ${stages.length === 1 ? 'that stage' : 'those stages'} (Library) or switch automatic running off for ${stages.length === 1 ? 'it' : 'them'}.`;
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

/** The entry stage's two switches are one control on the Pipeline page, named for what it does and not for a stage. */
const ENTRY_GATE_LABEL = 'Start queued issues automatically';

const STAGE_SETTING_LABELS: Record<string, string> = {
  deviceIds: 'Runner pools',
  allowedTools: 'Stage permissions',
  disallowedTools: 'Stage permissions',
  mcpServers: 'Stage permissions',
  mode: ENTRY_GATE_LABEL,
  enabled: ENTRY_GATE_LABEL,
};

/** `states.open.deviceIds` → "Runner pools (Open)"; `intakeGate.enabled` → "Intake gate"; `states.open.mode` → the switch's own name. */
export function settingLabel(path: string): string {
  const parts = path.split('.');
  if (parts[0] === 'states' && parts.length >= 3) {
    const leaf = STAGE_SETTING_LABELS[parts[2]] ?? 'Stage settings';
    return leaf === ENTRY_GATE_LABEL ? leaf : `${leaf} (${stageLabel(parts[1])})`;
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

/** The fields of a stage that share one section name ("Stage permissions"), so edits to two of them are told apart. */
const STAGE_FIELD_LABELS: Record<string, string> = {
  disallowedTools: 'Denied tools',
  allowedTools: 'Allowed tools',
  mcpServers: 'MCP servers',
};

function stageFieldLabel(path: string): string | undefined {
  const parts = parsePath(path);
  if (parts[0] !== 'states' || parts.length < 3) return undefined;
  if (parts[2] === 'mcpServers' && parts.length >= 4) return `MCP server ${parts[3]}`;
  return STAGE_FIELD_LABELS[parts[2] as string];
}

/** The fields of a section that a sentence about a change has to be able to tell apart. */
const FIELD_LABELS: Record<string, string> = {
  'intakeGate.enabled': 'Require approval',
  'intakeGate.notify': 'Notify the owner',
  'poolBacklog.statuses': 'Statuses',
  'poolBacklog.limit': 'Rows a master may read',
  'knowledgePromotion.enabled': 'Enabled',
  'knowledgePromotion.candidatesPerRun': 'Proposals per night',
  'knowledgePromotion.minRetrievals': 'Minimum retrievals',
  'assistantWeekly.enabled': 'Enabled',
  'assistantWeekly.pinnedIssue': 'Pinned issue',
  'assistantWeekly.judgeProviderId': 'Judge provider',
  'assistantWeekly.judgeModel': 'Judge model',
  'live.url': 'URL',
  'live.commitUrl': 'Commit URL',
  'live.commitPath': 'Commit path',
  'preview.url': 'URL',
  'preview.apiUrl': 'API URL',
  'preview.urls': 'Testing URLs',
};

/** Dotted document paths in the screen's own names, and how many settings that names. A section
 *  whose fields the screen tells apart is named with them, so "Knowledge promotion (Minimum
 *  retrievals)" says what moved and what did not. */
export function describeSettings(paths: string[]): { text: string; count: number } {
  const groups = new Map<string, Set<string>>();
  const order = Object.keys(FIELD_LABELS);
  const known = (path: string) => (order.includes(path) ? order.indexOf(path) : order.length);
  for (const path of [...paths].sort((a, b) => known(a) - known(b))) {
    const section = settingLabel(path);
    const fields = groups.get(section) ?? new Set<string>();
    const field = FIELD_LABELS[path] ?? stageFieldLabel(path);
    if (field) fields.add(field);
    groups.set(section, fields);
  }
  let count = 0;
  const named = [...groups].map(([section, fields]) => {
    count += Math.max(fields.size, 1);
    return fields.size > 0 ? `${section} (${listOf([...fields])})` : section;
  });
  return { text: listOf(named), count };
}

/** The same phrase without the count. */
export function settingsThatMoved(paths: string[]): string {
  return describeSettings(paths).text;
}

/** "was" for one setting, "were" for several. */
export function wasOrWere(count: number): 'was' | 'were' {
  return count === 1 ? 'was' : 'were';
}

/**
 * What a refused settings save reads as on screen: the settings that moved, in the
 * screen's own names, and that nothing was written. The re-read is an action beside this
 * sentence rather than an instruction inside it.
 */
export function formatSettingsWriteError(err: unknown): string {
  const conflicts = writeConflicts(err);
  if (conflicts.length === 0) return formatApiError(err);
  const { text, count } = describeSettings(conflicts.map((c) => c.path));
  return `${text} ${wasOrWere(count)} changed by someone else while this page was open. Nothing was saved — your edits are still here.`;
}
