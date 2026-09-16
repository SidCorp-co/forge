import type { Task } from '../task.js';

/** A request to change how the assistant answers lands as one `answer_style` row, not as prose. */
export const preferenceBullets: Task = {
  id: 'preference-bullets',
  intent: 'Change the answer style to bullet points and keep it for later replies.',
  budgetSeconds: 90,
  // cm:why the style is set to default first: on an account already at bullets the assistant's write is a no-op that leaves no row, and the task would fail a correct answer
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
