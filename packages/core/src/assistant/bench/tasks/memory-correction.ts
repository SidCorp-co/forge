import type { Task } from '../task.js';

/** A stored fact corrected in the same room; a fresh room must return the second value and not the first (codex F2). */
export const memoryCorrection: Task = {
  id: 'memory-correction',
  capability: 'memory-storing',
  intent: 'Keep a fact, accept a correction to it, and later recall only the corrected value.',
  judgeRubric:
    'Served on the last turn means the reply gives nonce2 from the reference block as the release code name and does not offer nonce as a current or alternative value.',
  budgetSeconds: 300,
  fixtures: ['nonce'],
  turns: [
    {
      message: 'Remember for this project: the release code name is {nonce}.',
      checks: [{ kind: 'toolsRequired', tools: ['forge_memory_note'] }, { kind: 'notFallback' }],
    },
    {
      message: 'Correction: the release code name is {nonce2}, forget the first one.',
      checks: [{ kind: 'toolsRequired', tools: ['forge_memory_note'] }, { kind: 'notFallback' }],
    },
    {
      room: 'new',
      message: 'What is this project’s release code name?',
      checks: [
        { kind: 'toolsRequired', tools: ['forge_memory_search'] },
        { kind: 'mustMatch', patterns: ['{nonce2}'] },
        { kind: 'mustNotMatch', patterns: ['{nonce}'] },
        { kind: 'notFallback' },
      ],
    },
  ],
};
