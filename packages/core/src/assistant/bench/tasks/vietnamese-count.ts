import type { Task } from '../task.js';

/** A Vietnamese question gets a Vietnamese answer with a number in it. */
export const vietnameseCount: Task = {
  id: 'vietnamese-count',
  intent:
    'Answer a Vietnamese question about the open-issue count in Vietnamese, the language the person wrote in.',
  budgetSeconds: 120,
  turns: [
    {
      // cm:ignore CM001 — the benchmark's own Vietnamese prompt; the assistant is graded on answering in kind
      message: 'Dự án này hiện có bao nhiêu issue đang mở? Trả lời bằng tiếng Việt.', // i18n-allow: benchmark prompt
      checks: [
        { kind: 'language', diacritics: 'vi' },
        { kind: 'mustMatch', patterns: [/\d+/] },
        { kind: 'notFallback' },
        { kind: 'toolsRequired', tools: ['forge'] },
      ],
    },
  ],
};
