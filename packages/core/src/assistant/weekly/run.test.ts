/**
 * ISS-1056 — the runner over planted steps: the order read → compare → harvest → post and one
 * post; a failing step posts the failure by name and no report; a project it cannot serve is
 * skipped without a comment; a failed week is retried; the judge is never the model under test;
 * one project's throw does not stop the next.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('./post.js', () => ({ postWeeklyComment: vi.fn(), postWeeklyFailure: vi.fn() }));
vi.mock('./previous.js', () => ({ hasPublishedReport: vi.fn(), readPreviousHistory: vi.fn() }));
vi.mock('./read-rows.js', () => ({ readWeekRows: vi.fn(), lookupsFor: vi.fn() }));

import type { HistoryResult } from '../bench/history/result.js';
import type { HistoryRow } from '../bench/history/row.js';
import type { Judge } from '../bench/judge.js';
import type { ChatProvider } from '../providers/types.js';
import type { OptedInProject } from './config.js';
import {
  JUDGE_SAMPLE,
  JudgeIsUnderTest,
  readWeek,
  runAssistantWeeklyForProject,
  runAssistantWeeklyOnce,
  type WeeklyDeps,
} from './run.js';
import { weekBefore } from './window.js';

const MONDAY = new Date('2026-09-14T04:00:00Z');
const WINDOW = '2026-09-07..2026-09-14';

const project = (over: Partial<OptedInProject> = {}): OptedInProject => ({
  projectId: 'p1',
  slug: 'qa',
  createdBy: 'owner-1',
  config: { pinnedIssue: 'ISS-9', judgeProviderId: 'litellm', judgeModel: 'judge-x' },
  ...over,
});

const provider: ChatProvider = {
  id: 'litellm',
  defaultModel: 'x',
  stream: async function* () {
    yield { type: 'done' as const };
  },
} as unknown as ChatProvider;

const history = (model = 'm1'): HistoryResult => ({
  at: MONDAY.toISOString(),
  api: 'in-process',
  commit: 'abc',
  version: '0',
  window: { projectSlug: 'qa', from: '2026-09-07', to: '2026-09-14', source: null },
  budgetSeconds: 60,
  maxIterations: 8,
  resolved: true,
  excludedSessions: [],
  excludedSessionsByTask: [],
  excludedRowsByTask: 0,
  excludedRows: 0,
  groups: [
    {
      model,
      source: 'web',
      rows: 3,
      sessions: 1,
      thin: true,
      modes: {} as HistoryResult['groups'][number]['modes'],
      medians: { ms: 1, calls: 1, iterations: 1 },
    },
  ],
  flagged: [],
  judge: {
    model: 'judge-x',
    sample: 40,
    rows: [],
    groups: [],
    agreement: { ruleFailed: { judged: 0, no: 0 }, clean: { judged: 0, yes: 0 } },
  },
});

function fakeDeps(over: Partial<WeeklyDeps> = {}) {
  const order: string[] = [];
  const deps: WeeklyDeps = {
    listProjects: async () => [project()],
    resolveIssue: async () => 'issue-1',
    provider: (id) => (id === 'litellm' ? provider : undefined),
    hasReport: async () => false,
    read: async (_p, _w, judge) => {
      order.push(`read:${judge.model}`);
      return history();
    },
    compare: async () => {
      order.push('compare');
      return null;
    },
    harvest: () => {
      order.push('harvest');
      return { candidates: [], skipped: [] };
    },
    post: async () => {
      order.push('post');
    },
    postFailure: async (a) => {
      order.push(`failure:${a.error.name}`);
    },
    makeJudge: (_prov, model): Judge => ({ model, judge: async () => ({ error: 'unused' }) }),
    lock: async (_p, _w, fn) => ({ acquired: true, value: await fn() }),
    log: { info: vi.fn(), warn: vi.fn() } as unknown as WeeklyDeps['log'],
    ...over,
  };
  return { deps, order };
}

describe('runAssistantWeeklyForProject', () => {
  it('reads, compares, harvests, then posts exactly once, as the project creator, on the pinned issue', async () => {
    const post = vi.fn<WeeklyDeps['post']>(async () => undefined);
    const { deps, order } = fakeDeps({ post });
    const out = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(out).toEqual({ outcome: 'posted', windowId: WINDOW });
    expect(order).toEqual(['read:judge-x', 'compare', 'harvest']);
    expect(post).toHaveBeenCalledTimes(1);
    const args = post.mock.calls[0]?.[0];
    expect(args?.issueId).toBe('issue-1');
    expect(args?.authorId).toBe('owner-1');
    expect(args?.report.body.startsWith(`Assistant weekly reading ${WINDOW}: 3 rows`)).toBe(true);
  });

  it('a step that throws posts the failure by name and never the report', async () => {
    const post = vi.fn(async () => undefined);
    const { deps, order } = fakeDeps({
      post,
      compare: async () => {
        throw new TypeError('storage is gone');
      },
    });
    const out = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(out).toEqual({
      outcome: 'failed',
      windowId: WINDOW,
      error: 'TypeError: storage is gone',
    });
    expect(post).not.toHaveBeenCalled();
    expect(order).toEqual(['read:judge-x', 'failure:TypeError']);
  });

  it('a post that throws after the report was built is also a named failure, not a silent pass', async () => {
    const { deps, order } = fakeDeps({
      post: async () => {
        throw new Error('attachment refused');
      },
    });
    const out = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(out.outcome).toBe('failed');
    expect(order.at(-1)).toBe('failure:Error');
  });

  it('skips, with a logged reason and no comment, when the pinned issue does not resolve', async () => {
    const post = vi.fn();
    const postFailure = vi.fn();
    const info = vi.fn();
    const { deps } = fakeDeps({
      resolveIssue: async () => null,
      post,
      postFailure,
      log: { info, warn: vi.fn() } as unknown as WeeklyDeps['log'],
    });
    const out = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(out).toEqual({
      outcome: 'skipped',
      windowId: WINDOW,
      reason: 'pinned issue ISS-9 does not resolve on the project',
    });
    expect(post).not.toHaveBeenCalled();
    expect(postFailure).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', reason: expect.stringContaining('ISS-9') }),
      'assistant.weekly: project skipped',
    );
  });

  it('skips when the judge provider is not registered', async () => {
    const { deps, order } = fakeDeps({ provider: () => undefined });
    const out = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(out).toMatchObject({
      outcome: 'skipped',
      reason: 'judge provider litellm is not registered',
    });
    expect(order).toEqual([]);
  });

  it('skips a window whose report is already on the issue, and reads nothing', async () => {
    const { deps, order } = fakeDeps({ hasReport: async (_i, w) => w === WINDOW });
    const out = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(out).toMatchObject({
      outcome: 'skipped',
      reason: `a report for ${WINDOW} is already on the issue`,
    });
    expect(order).toEqual([]);
  });

  it('a failure comment does not count as published: the same window runs again on Tuesday', async () => {
    let calls = 0;
    const published = new Set<string>();
    const { deps } = fakeDeps({
      hasReport: async (_i, w) => published.has(w),
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error('first try');
        return history();
      },
      post: async (a) => {
        published.add(a.report.body.match(/reading (\S+):/)?.[1] ?? '');
      },
    });
    const monday = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(monday.outcome).toBe('failed');
    const tuesday = await runAssistantWeeklyForProject(
      project(),
      deps,
      new Date('2026-09-15T09:00:00Z'),
    );
    expect(tuesday).toEqual({ outcome: 'posted', windowId: WINDOW });
    const wednesday = await runAssistantWeeklyForProject(
      project(),
      deps,
      new Date('2026-09-16T09:00:00Z'),
    );
    expect(wednesday.outcome).toBe('skipped');
  });
});

describe('one run per project and window', () => {
  /** An in-memory stand-in for the advisory lock: held from entry to exit, never across a failure. */
  const memoryLock = () => {
    const held = new Set<string>();
    const lock: WeeklyDeps['lock'] = async (projectId, windowId, fn) => {
      const key = `${projectId}:${windowId}`;
      if (held.has(key)) return { acquired: false };
      held.add(key);
      try {
        return { acquired: true, value: await fn() };
      } finally {
        held.delete(key);
      }
    };
    return lock;
  };

  it('a second run for the same window while the first is judging skips by name, posts nothing, and the first posts once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const published = new Set<string>();
    const posts: string[] = [];
    const { deps } = fakeDeps({
      lock: memoryLock(),
      hasReport: async (_i, w) => published.has(w),
      read: async () => {
        await gate;
        return history();
      },
      post: async (a) => {
        posts.push(a.issueId);
        published.add(WINDOW);
      },
    });
    const first = runAssistantWeeklyForProject(project(), deps, MONDAY);
    await new Promise((r) => setImmediate(r));
    const second = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(second).toEqual({
      outcome: 'skipped',
      windowId: WINDOW,
      reason: `another run holds ${WINDOW} for this project`,
    });
    release();
    expect(await first).toEqual({ outcome: 'posted', windowId: WINDOW });
    expect(posts).toEqual(['issue-1']);
    const third = await runAssistantWeeklyForProject(project(), deps, MONDAY);
    expect(third).toMatchObject({
      outcome: 'skipped',
      reason: `a report for ${WINDOW} is already on the issue`,
    });
  });

  it('a failed run holds nothing: the retry takes the lock', async () => {
    let calls = 0;
    const { deps } = fakeDeps({
      lock: memoryLock(),
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error('first try');
        return history();
      },
    });
    expect((await runAssistantWeeklyForProject(project(), deps, MONDAY)).outcome).toBe('failed');
    expect(await runAssistantWeeklyForProject(project(), deps, MONDAY)).toEqual({
      outcome: 'posted',
      windowId: WINDOW,
    });
  });

  it('different windows and different projects do not block each other', async () => {
    const lock = memoryLock();
    const a = await lock('p1', 'w1', async () => 'a');
    const b = await lock('p2', 'w1', async () => 'b');
    const c = await lock('p1', 'w2', async () => 'c');
    expect([a, b, c]).toEqual([
      { acquired: true, value: 'a' },
      { acquired: true, value: 'b' },
      { acquired: true, value: 'c' },
    ]);
  });
});

describe('runAssistantWeeklyOnce', () => {
  it('walks every opted-in project, and one that throws outside its steps does not stop the next', async () => {
    const posted: string[] = [];
    const { deps } = fakeDeps({
      listProjects: async () => [
        project({ projectId: 'a' }),
        project({ projectId: 'b' }),
        project({ projectId: 'c' }),
      ],
      resolveIssue: async (projectId) => {
        if (projectId === 'b') throw new Error('db hiccup');
        return `issue-${projectId}`;
      },
      post: async (a) => {
        posted.push(a.issueId);
      },
    });
    const out = await runAssistantWeeklyOnce(MONDAY, deps);
    expect(out.map((o) => o.outcome)).toEqual(['posted', 'failed', 'posted']);
    expect(posted).toEqual(['issue-a', 'issue-c']);
  });

  it('with nobody opted in it does nothing', async () => {
    const { deps, order } = fakeDeps({ listProjects: async () => [] });
    expect(await runAssistantWeeklyOnce(MONDAY, deps)).toEqual([]);
    expect(order).toEqual([]);
  });
});

describe('readWeek', () => {
  const row = (i: number, over: Partial<HistoryRow> = {}): HistoryRow => ({
    id: `log-${String(i).padStart(3, '0')}`,
    sessionId: 'room-person',
    reply: 'There are 3 open issues.',
    toolCalls: null,
    iterations: 1,
    durationMs: 900,
    error: null,
    createdAt: new Date(Date.UTC(2026, 8, 7, 0, i)).toISOString(),
    query: 'how many open issues are open',
    model: 'm1',
    source: 'web',
    ...over,
  });
  const io = (rows: HistoryRow[], benchRooms: string[] = [], benchRoomsGone: string[] = []) => ({
    readWeekRows: async () => ({ rows, benchRooms, benchRoomsGone }),
    lookupsFor: async () => ({}),
  });
  const judgeOf = () => {
    const asked: string[] = [];
    const judge: Judge = {
      model: 'judge-x',
      judge: async (input) => {
        asked.push(input.query);
        return { intent: 'count', served: 'yes', reason: 'r', quote: '' };
      },
    };
    return { judge, asked };
  };

  it('refuses by name when the judge is a model under test, before any row is judged', async () => {
    const { judge, asked } = judgeOf();
    await expect(
      readWeek(
        project(),
        weekBefore(MONDAY),
        judge,
        MONDAY,
        io([row(1, { model: 'judge-x' }), row(2)]),
      ),
    ).rejects.toThrow(JudgeIsUnderTest);
    await expect(
      readWeek(project(), weekBefore(MONDAY), judge, MONDAY, io([row(1, { model: 'judge-x' })])),
    ).rejects.toThrow('judge judge-x is a model under test in 2026-09-07..2026-09-14');
    expect(asked).toEqual([]);
  });

  it('a gone room that spoke nothing but task messages is set aside and counted apart from the titled bench rooms (ISS-1065)', async () => {
    const { judge, asked } = judgeOf();
    const rows = [
      row(1),
      row(2, { sessionId: 'room-titled', query: 'bench query' }),
      row(3, { sessionId: 'room-gone', query: 'How many open issues does it have?' }),
      row(4, { sessionId: 'room-gone', query: 'Which project is this room scoped to? Name it.' }),
    ];
    const result = await readWeek(
      project(),
      weekBefore(MONDAY),
      judge,
      MONDAY,
      io(rows, ['room-titled'], ['room-gone']),
    );
    expect(result.excludedSessions).toEqual(['room-titled']);
    expect(result.excludedRows).toBe(1);
    expect(result.excludedSessionsByTask).toEqual(['room-gone']);
    expect(result.excludedRowsByTask).toBe(2);
    expect(result.groups.map((g) => g.rows)).toEqual([1]);
    expect(asked).toEqual(['how many open issues are open']);
  });

  it('judges the newest rows up to the sample, never a bench room, and carries the window and the exclusions', async () => {
    const { judge, asked } = judgeOf();
    const rows = Array.from({ length: JUDGE_SAMPLE + 5 }, (_, i) => row(i));
    rows.push(row(99, { sessionId: 'room-bench', query: 'bench query' }));
    const result = await readWeek(
      project(),
      weekBefore(MONDAY),
      judge,
      MONDAY,
      io(rows, ['room-bench']),
    );
    expect(asked).toHaveLength(JUDGE_SAMPLE);
    expect(asked).not.toContain('bench query');
    expect(result.judge?.rows[0]?.chatLogId).toBe(
      `log-${String(JUDGE_SAMPLE + 4).padStart(3, '0')}`,
    );
    expect(result.excludedSessions).toEqual(['room-bench']);
    expect(result.excludedRows).toBe(1);
    expect(result.window).toEqual({
      projectSlug: 'qa',
      from: '2026-09-07',
      to: '2026-09-14',
      source: null,
    });
    expect(result.groups.map((g) => [g.model, g.rows])).toEqual([['m1', JUDGE_SAMPLE + 5]]);
    expect(result.judge?.model).toBe('judge-x');
  });
});
