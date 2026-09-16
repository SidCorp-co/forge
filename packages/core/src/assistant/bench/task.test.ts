/**
 * ISS-1051 — the task set is data a test can load whole: every shipped task loads, and a list the
 * grader could not walk is refused by name, so a task added later cannot pass by carrying nothing.
 */

import { describe, expect, it } from 'vitest';
import { fill, type Task, validateTasks } from './task.js';
import { loadTasks, SHIPPED_TASKS } from './tasks/index.js';

const base: Task = {
  id: 'x',
  capability: 'method',
  intent: 'a planted intent',
  budgetSeconds: 10,
  turns: [{ message: 'hi', checks: [{ kind: 'notFallback' }] }],
};

/** The plan's task matrix, bound below: one row per shipped task. */
const MATRIX: Record<
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
    messages: ['List the open issues in this project, one line each, with a link to each issue.'],
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
      ['linkShape', 'linksResolve', 'mustMatch', 'toolsRequired', 'noPlaceholder', 'screenRepair'],
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
  'project-issue-counts': {
    messages: [
      'How many issues does this project have that are open, how many are closed, and how many are still drafts? Give the three counts.',
    ],
    kinds: [
      ['labeled', 'labeled', 'labeled', 'toolsRequired', 'notFallback', 'noHelp', 'noPlaceholder'],
    ],
    fixtures: ['issueCounts'],
  },
  'project-pipeline-states': {
    messages: [
      'List this project’s pipeline states in order, from the first an issue enters to the last, using the exact state keys the pipeline config names.',
    ],
    kinds: [['listInOrder', 'notFallback', 'noHelp', 'noPlaceholder']],
    fixtures: ['pipelineStates'],
  },
  'project-waiting-issue': {
    messages: [
      'Which issue in this project is waiting on more information right now? Name it by key and link it.',
    ],
    kinds: [
      [
        'mustMatch',
        'linkTo',
        'linkShape',
        'linksResolve',
        'toolsRequired',
        'notFallback',
        'noHelp',
      ],
    ],
    fixtures: ['waitingIssue'],
  },
  'memory-store-recall': {
    messages: [
      'Remember for this project: the release code name is {nonce}.',
      'What is this project’s release code name?',
    ],
    kinds: [
      ['toolsRequired', 'notFallback', 'noHelp'],
      ['toolsRequired', 'mustMatch', 'notFallback', 'noHelp'],
    ],
    fixtures: ['nonce'],
  },
  'memory-correction': {
    messages: [
      'Remember for this project: the release code name is {nonce}.',
      'Correction: the release code name is {nonce2}, forget the first one.',
      'What is this project’s release code name?',
    ],
    kinds: [
      ['toolsRequired', 'notFallback'],
      ['toolsRequired', 'notFallback'],
      ['toolsRequired', 'mustMatch', 'mustNotMatch', 'notFallback'],
    ],
    fixtures: ['nonce'],
  },
  'long-context-needle': {
    messages: [
      expect.stringMatching(
        /^Here are the release notes[\s\S]{9000,}Question: on which weekday does the on-call rota for \{nonce\} turn over\?$/,
      ),
    ],
    kinds: [['mustMatch', 'maxIterations', 'maxCalls', 'notFallback', 'noHelp']],
    fixtures: ['nonce'],
  },
  'long-context-thread': {
    messages: [
      ...Array.from({ length: 8 }, () => expect.stringMatching(/\w/)),
      'Unrelated: how many open issues does this project have right now?',
      'Back to the release: who reviews it, and on which weekday do we deploy? Answer both, reviewer first.',
    ],
    kinds: [
      ...Array.from({ length: 8 }, () => ['notFallback', 'noHelp']),
      ['mustMatch', 'toolsRequired', 'notFallback', 'noHelp'],
      ['inOrder', 'mustNotMatch', 'notFallback', 'noHelp'],
    ],
  },
};

describe('the shipped set', () => {
  it('loads seventeen tasks in the order a run walks them', () => {
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
      'project-issue-counts',
      'project-pipeline-states',
      'project-waiting-issue',
      'memory-store-recall',
      'memory-correction',
      'long-context-needle',
      'long-context-thread',
    ]);
  });

  it('every task names its capability; the ten from ISS-1051 measure the method', () => {
    const byCapability: Record<string, string[]> = {};
    for (const t of SHIPPED_TASKS)
      byCapability[t.capability] = [...(byCapability[t.capability] ?? []), t.id];
    expect(byCapability.method).toHaveLength(10);
    expect(byCapability['project-understanding']).toEqual([
      'project-issue-counts',
      'project-pipeline-states',
      'project-waiting-issue',
    ]);
    expect(byCapability['memory-storing']).toEqual(['memory-store-recall', 'memory-correction']);
    expect(byCapability['long-context']).toEqual(['long-context-needle', 'long-context-thread']);
    for (const t of SHIPPED_TASKS.filter((x) => x.capability !== 'method'))
      expect(t.judgeRubric, t.id).toMatch(/^Served/);
  });

  it('every task carries a budget in seconds', () => {
    for (const task of SHIPPED_TASKS) expect(task.budgetSeconds, task.id).toBeGreaterThan(0);
  });

  it('binds each task to the plan matrix: messages, check kinds, fixtures and preference moves', () => {
    for (const task of SHIPPED_TASKS) {
      const row = MATRIX[task.id];
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

  it('a task with no capability or one outside the list, naming the list', () => {
    const { capability: _dropped, ...none } = base;
    expect(() => validateTasks([none as unknown as Task])).toThrow(
      'task x names capability undefined, not one of method, project-understanding, memory-storing, long-context',
    );
    expect(() =>
      validateTasks([{ ...base, capability: 'vibes' as unknown as Task['capability'] }]),
    ).toThrow('names capability vibes');
  });

  it('a judge rubric over one line or 300 characters', () => {
    expect(() => validateTasks([{ ...base, judgeRubric: 'one\ntwo' }])).toThrow(
      'task x judgeRubric must be one line under 300 characters',
    );
    expect(() => validateTasks([{ ...base, judgeRubric: 'x'.repeat(301) }])).toThrow(
      'judgeRubric must be one line',
    );
    expect(
      validateTasks([{ ...base, judgeRubric: 'Served means the answer is right.' }]),
    ).toHaveLength(1);
  });

  it('a new room on the first turn, which is the turn that opens the room', () => {
    const turn = base.turns[0];
    if (!turn) throw new Error('base has no turn');
    expect(() => validateTasks([{ ...base, turns: [{ ...turn, room: 'new' }] }])).toThrow(
      'task x turn 1 asks for a new room, and the first turn opens the room',
    );
    expect(
      validateTasks([{ ...base, turns: [turn, { ...turn, room: 'new' }] }])[0]?.turns[1]?.room,
    ).toBe('new');
  });

  it('a listInOrder list, a labeled value or a linkTo id with a placeholder no fixture fills', () => {
    const turn = base.turns[0];
    if (!turn) throw new Error('base has no turn');
    for (const check of [
      { kind: 'listInOrder', list: '{ghost}' },
      { kind: 'labeled', label: /open/i, value: '{ghost}' },
      { kind: 'linkTo', issueId: '{ghost}' },
    ] as const) {
      expect(() => validateTasks([{ ...base, turns: [{ ...turn, checks: [check] }] }])).toThrow(
        '{ghost}',
      );
    }
  });

  it('an inOrder pattern with a placeholder no fixture fills', () => {
    const turn = base.turns[0];
    if (!turn) throw new Error('base has no turn');
    expect(() =>
      validateTasks([
        { ...base, turns: [{ ...turn, checks: [{ kind: 'inOrder', patterns: ['{ghost}'] }] }] },
      ]),
    ).toThrow('{ghost}');
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
