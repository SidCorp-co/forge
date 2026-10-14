/** The actions `forge_issues` serves. A retired name is refused by name, never with the schema's raw validation array. */
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

const REMOVED_ISSUE_ACTIONS: Readonly<Record<string, string>> = {
  createTask: 'subtasks were removed (ISS-1132)',
  listTasks: 'subtasks were removed (ISS-1132)',
  updateTask: 'subtasks were removed (ISS-1132)',
  deleteTask: 'subtasks were removed (ISS-1132)',
};

export function refuseUnservedIssueAction(action: unknown): void {
  if (typeof action !== 'string' || (ISSUE_ACTIONS as readonly string[]).includes(action)) return;
  const why = Object.hasOwn(REMOVED_ISSUE_ACTIONS, action)
    ? `was removed: ${REMOVED_ISSUE_ACTIONS[action]}`
    : 'is not a forge_issues action';
  throw new Error(
    `BAD_REQUEST: action \`${action}\` ${why}. Actions served: ${ISSUE_ACTIONS.join(', ')}.`,
  );
}
