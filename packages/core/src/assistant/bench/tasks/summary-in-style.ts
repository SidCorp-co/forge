import type { Task } from '../task.js';

/** With the style set to bullets before the turn, a prose summary is the regression. */
export const summaryInStyle: Task = {
  id: 'summary-in-style',
  capability: 'method',
  intent: 'Summarize what the project is about in one message, in the style the person set.',
  judgeRubric:
    'Served means the summary says what the project brief’s name and description say this project is, and is written as bullets because that is the style the person set.',
  budgetSeconds: 90,
  preference: { setup: { answerStyle: 'bullets' }, restore: 'baseline' },
  turns: [
    {
      message: 'Summarize what this project is about in one message.',
      checks: [
        { kind: 'mustMatch', patterns: [/^\s*[-*•]\s/m] },
        { kind: 'notFallback' },
        { kind: 'screenRepair' },
      ],
    },
  ],
};
