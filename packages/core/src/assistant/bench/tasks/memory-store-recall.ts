import type { Task } from '../task.js';

/** A fact kept in one room and read back in a fresh one: the token is random per trial, so only a stored note can carry it across. */
export const memoryStoreRecall: Task = {
  id: 'memory-store-recall',
  capability: 'memory-storing',
  intent:
    'Keep a fact for the project when asked to, and recall it later from a room that never saw it.',
  judgeRubric:
    'Served on the second turn means the reply states the release code name equal to nonce in the reference block, read from memory rather than asked for again.',
  budgetSeconds: 240,
  fixtures: ['nonce'],
  turns: [
    {
      message: 'Remember for this project: the release code name is {nonce}.',
      checks: [
        { kind: 'toolsRequired', tools: ['forge_memory_note'] },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
      ],
    },
    {
      room: 'new',
      message: 'What is this project’s release code name?',
      checks: [
        { kind: 'toolsRequired', tools: ['forge_memory_search'] },
        { kind: 'mustMatch', patterns: ['{nonce}'] },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
      ],
    },
  ],
};
