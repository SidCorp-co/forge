import type { Task } from '../task.js';

/** "It" in the second turn is the project the first turn named; the follow-up must resolve it. */
export const memoryFollowup: Task = {
  id: 'memory-followup',
  intent: 'Name the project this room is scoped to and count its open issues.',
  budgetSeconds: 120,
  fixtures: ['projectName'],
  turns: [
    {
      message: 'Which project is this room scoped to? Name it.',
      checks: [{ kind: 'mustMatch', patterns: ['{projectName}'] }, { kind: 'notFallback' }],
    },
    {
      message: 'How many open issues does it have?',
      checks: [
        { kind: 'mustMatch', patterns: [/\d+/] },
        { kind: 'notFallback' },
        { kind: 'toolsRequired', tools: ['forge'] },
        { kind: 'noHelp' },
        { kind: 'noPlaceholder' },
      ],
    },
  ],
};
