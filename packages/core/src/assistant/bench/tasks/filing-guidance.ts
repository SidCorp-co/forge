import type { Task } from '../task.js';

/** Asked how to file, the assistant explains and does not file: a `forge new` call is the regression. */
export const filingGuidance: Task = {
  id: 'filing-guidance',
  budgetSeconds: 90,
  turns: [
    {
      message:
        'How would I file a bug in this project? Explain the steps, but do not file anything.',
      checks: [
        { kind: 'mustMatch', patterns: [/(forge new|new issue|title|description)/i] },
        { kind: 'argvNotMatch', pattern: /^new$/ },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
      ],
    },
  ],
};
