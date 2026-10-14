/**
 * The actions `forge_issues` serves, and the ones it no longer does.
 *
 * A caller holding a removed action is refused by name — which action, which change removed it and
 * what is still served — and never with the schema's raw validation array, which says an enum did
 * not match and leaves the caller to guess whether the name was mistyped or retired.
 */

export const ISSUE_ACTIONS = [
  'list',
  'get',
  'create',
  'update',
  'transition',
  'mark_merged',
  'unmark',
  'setAttributes',
  'archive',
  'unarchive',
] as const;

/** Actions that were served and are not, each with what removed it, so the refusal can say so. */
const REMOVED_ISSUE_ACTIONS: Readonly<Record<string, string>> = {
  createTask: 'subtasks were removed (ISS-1132)',
  listTasks: 'subtasks were removed (ISS-1132)',
  updateTask: 'subtasks were removed (ISS-1132)',
  deleteTask: 'subtasks were removed (ISS-1132)',
};

/**
 * Throws the refusal for an `action` outside {@link ISSUE_ACTIONS}; returns for a served one and
 * for a missing or non-string one, which the input schema's own refusal already answers by field.
 */
export function refuseUnservedIssueAction(action: unknown): void {
  if (typeof action !== 'string' || (ISSUE_ACTIONS as readonly string[]).includes(action)) return;
  const why = Object.hasOwn(REMOVED_ISSUE_ACTIONS, action)
    ? `was removed: ${REMOVED_ISSUE_ACTIONS[action]}`
    : 'is not a forge_issues action';
  throw new Error(
    `BAD_REQUEST: action \`${action}\` ${why}. Actions served: ${ISSUE_ACTIONS.join(', ')}.`,
  );
}
