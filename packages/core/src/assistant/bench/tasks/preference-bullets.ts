import type { Task } from '../task.js';

/** A request to change how the assistant answers lands as one `answer_style` row, not as prose. */
export const preferenceBullets: Task = {
  id: 'preference-bullets',
  capability: 'method',
  intent: 'Change the answer style to bullet points and keep it for later replies.',
  budgetSeconds: 90,
  preference: { setup: { answerStyle: 'default' }, restore: 'baseline' },
  turns: [
    {
      message: 'From now on, answer me in bullet points.',
      checks: [
        { kind: 'preferenceRows', rows: [{ field: 'answer_style', newValue: 'bullets' }] },
        { kind: 'notFallback' },
        { kind: 'maxIterations', max: 6 },
      ],
    },
  ],
};
