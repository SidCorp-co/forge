import type { Task } from '../task.js';

/** A change and its undo are two rows: the second names the first's value as what it moved from. */
export const preferenceRestore: Task = {
  id: 'preference-restore',
  capability: 'method',
  intent: 'Set a preference and then undo it, leaving the earlier value in place.',
  budgetSeconds: 120,
  preference: { setup: { answerStyle: 'default' }, restore: 'baseline' },
  turns: [
    {
      message: 'From now on, answer concisely.',
      checks: [{ kind: 'preferenceRows', rows: [{ field: 'answer_style', newValue: 'concise' }] }],
    },
    {
      message: 'Undo that preference change.',
      checks: [
        { kind: 'preferenceRows', rows: [{ field: 'answer_style', previousValue: 'concise' }] },
        { kind: 'notFallback' },
      ],
    },
  ],
};
