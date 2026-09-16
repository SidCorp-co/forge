/**
 * ISS-1051 — the task set is data a test can load whole: every shipped task loads, and a list the
 * grader could not walk is refused by name, so a task added later cannot pass by carrying nothing.
 */

import { describe, expect, it } from 'vitest';
import { fill, type Task, validateTasks } from './task.js';
import { loadTasks, SHIPPED_TASKS } from './tasks/index.js';

const base: Task = {
  id: 'x',
  intent: 'a planted intent',
  budgetSeconds: 10,
  turns: [{ message: 'hi', checks: [{ kind: 'notFallback' }] }],
};

describe('the shipped set', () => {
  it('loads ten tasks in the order a run walks them', () => {
    expect(loadTasks().map((t) => t.id)).toEqual([
      'memory-question',
      'memory-followup',
      'open-issues-linked',
      'one-issue-by-key',
      'preference-bullets',
      'summary-in-style',
      'out-of-reach-tests',
      'vietnamese-count',
      'filing-guidance',
      'preference-restore',
    ]);
  });

  it('every task carries a budget in seconds', () => {
    for (const task of SHIPPED_TASKS) expect(task.budgetSeconds, task.id).toBeGreaterThan(0);
  });

  it('binds each task to the plan matrix: messages, check kinds, fixtures and preference moves', () => {
    const matrix: Record<
      string,
      { messages: string[]; kinds: string[][]; fixtures?: string[]; setup?: string }
    > = {
      'memory-question': {
        messages: [
          'Please remember this for our chat: my deploy window is Thursday 14:00 UTC.',
          'When is my deploy window?',
        ],
        kinds: [
          ['notFallback', 'maxSeconds'],
          ['mustMatch', 'mustMatch', 'notFallback', 'toolsAllowed'],
        ],
      },
      'memory-followup': {
        messages: [
          'Which project is this room scoped to? Name it.',
          'How many open issues does it have?',
        ],
        kinds: [
          ['mustMatch', 'notFallback'],
          ['mustMatch', 'notFallback', 'toolsRequired', 'noHelp', 'noPlaceholder'],
        ],
        fixtures: ['projectName'],
      },
      'open-issues-linked': {
        messages: [
          'List the open issues in this project, one line each, with a link to each issue.',
        ],
        kinds: [
          [
            'linkShape',
            'linksResolve',
            'mustMatch',
            'toolsRequired',
            'noHelp',
            'noPlaceholder',
            'noRepeatedCall',
            'maxCalls',
            'screenRepair',
          ],
        ],
        fixtures: ['firstOpenIssue'],
      },
      'one-issue-by-key': {
        messages: ['What is {issueKey} about? One paragraph, then a link to it.'],
        kinds: [
          [
            'linkShape',
            'linksResolve',
            'mustMatch',
            'toolsRequired',
            'noPlaceholder',
            'screenRepair',
          ],
        ],
        fixtures: ['firstOpenIssue'],
      },
      'preference-bullets': {
        messages: ['From now on, answer me in bullet points.'],
        kinds: [['preferenceRows', 'notFallback', 'maxIterations']],
        setup: 'default',
      },
      'summary-in-style': {
        messages: ['Summarize what this project is about in one message.'],
        kinds: [['mustMatch', 'notFallback', 'screenRepair']],
        setup: 'bullets',
      },
      'out-of-reach-tests': {
        messages: ['Run the test suite for this project and tell me whether it passes.'],
        kinds: [['mustMatch', 'mustNotMatch', 'argvNotMatch', 'noPlaceholder']],
      },
      'vietnamese-count': {
        messages: ['Dự án này hiện có bao nhiêu issue đang mở? Trả lời bằng tiếng Việt.'], // i18n-allow: test fixture
        kinds: [['language', 'mustMatch', 'notFallback', 'toolsRequired']],
      },
      'filing-guidance': {
        messages: [
          'How would I file a bug in this project? Explain the steps, but do not file anything.',
        ],
        kinds: [['mustMatch', 'argvNotMatch', 'notFallback', 'noHelp']],
      },
      'preference-restore': {
        messages: ['From now on, answer concisely.', 'Undo that preference change.'],
        kinds: [['preferenceRows'], ['preferenceRows', 'notFallback']],
        setup: 'default',
      },
    };
    for (const task of SHIPPED_TASKS) {
      const row = matrix[task.id];
      expect(row, task.id).toBeDefined();
      expect(
        task.turns.map((t) => t.message),
        task.id,
      ).toEqual(row?.messages);
      expect(
        task.turns.map((t) => t.checks.map((c) => c.kind)),
        task.id,
      ).toEqual(row?.kinds);
      expect(task.fixtures ?? [], task.id).toEqual(row?.fixtures ?? []);
      expect(task.preference?.setup?.answerStyle, task.id).toEqual(row?.setup);
    }
  });
});

describe('what the loader refuses', () => {
  it('two tasks with one id, naming the id', () => {
    expect(() => validateTasks([base, { ...base }])).toThrow('task id x appears twice');
  });

  it('a turn with no check, naming the task and the turn', () => {
    const task: Task = { ...base, turns: [{ message: 'a', checks: [] }] };
    expect(() => validateTasks([task])).toThrow('task x turn 1 carries no check');
  });

  it('a check kind outside the vocabulary, naming task, turn and kind', () => {
    const bad = { kind: 'vibes' } as unknown as Task['turns'][number]['checks'][number];
    const task: Task = { ...base, turns: [{ message: 'a', checks: [bad] }] };
    expect(() => validateTasks([task])).toThrow(
      'task x turn 1 names check kind vibes, not in the vocabulary',
    );
  });

  it('a placeholder no fixture fills', () => {
    const task: Task = {
      ...base,
      turns: [{ message: 'What is {issueKey}?', checks: [{ kind: 'notFallback' }] }],
    };
    expect(() => validateTasks([task])).toThrow(
      'task x turn 1 reads {issueKey}, which no fixture of the task fills',
    );
    expect(() => validateTasks([{ ...task, fixtures: ['firstOpenIssue'] }])).not.toThrow();
  });

  it('a literal pattern with a placeholder no fixture fills', () => {
    const task: Task = {
      ...base,
      turns: [{ message: 'a', checks: [{ kind: 'mustMatch', patterns: ['{projectName}'] }] }],
    };
    expect(() => validateTasks([task])).toThrow('{projectName}');
  });

  it('a preference setup or a preferenceRows check with no restore', () => {
    const setup = { ...base, preference: { setup: { answerStyle: 'bullets' } } } as unknown as Task;
    expect(() => validateTasks([setup])).toThrow('task x moves a preference and names no restore');
    const rows: Task = {
      ...base,
      turns: [{ message: 'a', checks: [{ kind: 'preferenceRows', rows: [] }] }],
    };
    expect(() => validateTasks([rows])).toThrow('names no restore');
  });

  it('a task with no budget', () => {
    expect(() => validateTasks([{ ...base, budgetSeconds: 0 }])).toThrow('names no budget');
  });
});

describe('fill', () => {
  it('substitutes every placeholder and refuses one with no value', () => {
    expect(fill('{a} and {b}', { a: '1', b: '2' })).toBe('1 and 2');
    expect(() => fill('{c}', {})).toThrow('placeholder {c} has no value');
  });
});
