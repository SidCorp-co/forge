import { describe, expect, it } from 'vitest';
import { ISSUE_ACTIONS, refuseUnservedIssueAction } from './forge-issues-actions.js';

describe('refuseUnservedIssueAction', () => {
  it.each(ISSUE_ACTIONS)('lets the served action %s through', (action) => {
    expect(() => refuseUnservedIssueAction(action)).not.toThrow();
  });

  it.each(['createTask', 'listTasks', 'updateTask', 'deleteTask'])(
    'refuses %s by name as removed by ISS-1132 and lists what is served',
    (action) => {
      expect(() => refuseUnservedIssueAction(action)).toThrow(
        new RegExp(
          `^BAD_REQUEST: action \`${action}\` was removed: subtasks were removed \\(ISS-1132\\)\\. Actions served: list, get,`,
        ),
      );
    },
  );

  it('refuses a name that was never an action as not one, not as removed', () => {
    expect(() => refuseUnservedIssueAction('vibes')).toThrow(
      /`vibes` is not a forge_issues action/,
    );
  });

  it('does not match a removed name through the prototype chain', () => {
    expect(() => refuseUnservedIssueAction('constructor')).toThrow(/is not a forge_issues action/);
  });

  it('leaves a missing or non-string action to the input schema, which names the field', () => {
    expect(() => refuseUnservedIssueAction(undefined)).not.toThrow();
    expect(() => refuseUnservedIssueAction(7)).not.toThrow();
  });
});
