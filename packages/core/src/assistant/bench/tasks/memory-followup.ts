import type { Task } from '../task.js';

/** "It" in the second turn is the project the first turn named; the follow-up must resolve it. */
export const memoryFollowup: Task = {
  id: 'memory-followup',
  capability: 'method',
  intent: 'Name the project this room is scoped to and count its open issues.',
  // cm:why this task has a rubric although ISS-1066 named six others: it is the one the 17:42Z evidence was written about — the assistant answered 763 open issues against a project holding 682 and the judge said yes twice, having no count to hold it against
  judgeRubric:
    'On the scope turn, naming projectName serves it and no count is owed; on the count turn, served means the project’s own open count, as the brief’s counts-by-status line reports it — a number that is not that count is not served, however confidently given.',
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
