import type { Task } from '../task.js';

/** A change and its undo are two rows: the second names the first's value as what it moved from. */
export const preferenceRestore: Task = {
  id: 'preference-restore',
  capability: 'method',
  intent: 'Set a preference and then undo it, leaving the earlier value in place.',
  budgetSeconds: 120,
  // cm:why the style is set to default first: on an account already at concise the first turn's write is a no-op that leaves no row, and the undo has nothing to move back
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
