import type { Task } from '../task.js';

/** A fact stated in the room is answered from the room: forgetting it is the regression. */
export const memoryQuestion: Task = {
  id: 'memory-question',
  capability: 'method',
  intent: 'Remember a fact the person states and answer a later question from it.',
  judgeRubric:
    'Served means the reply gives the deploy window the person stated earlier in this exchange; the project brief describes the project, not this person, so a window read off it is not the answer.',
  budgetSeconds: 90,
  turns: [
    {
      message: 'Please remember this for our chat: my deploy window is Thursday 14:00 UTC.',
      checks: [{ kind: 'notFallback' }, { kind: 'maxSeconds' }],
    },
    {
      message: 'When is my deploy window?',
      checks: [
        { kind: 'mustMatch', patterns: [/thursday/i] },
        { kind: 'mustMatch', patterns: [/14:00/] },
        { kind: 'notFallback' },
        { kind: 'toolsAllowed', tools: ['forge_memory_search', 'forge_memory_note'] },
      ],
    },
  ],
};
