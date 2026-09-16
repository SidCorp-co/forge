import type { Task } from '../task.js';

/** With the style set to bullets before the turn, a prose summary is the regression. */
export const summaryInStyle: Task = {
  id: 'summary-in-style',
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
