/**
 * ISS-1053 - the verbs over the scripted deployment: refusals by name, one file written from a
 * seeded window, the bench rooms dropped by --exclude, --source and --resolve, and compare-history
 * printing and exiting 0.
 */

import { describe, expect, it } from 'vitest';
import { CORRECTIVE_PREFIX } from '../../../conversations/fallback-replies.js';
import { type CliDeps, main } from '../cli.js';
import {
  createFakeDeployment,
  DEAD_ISSUE_ID,
  FAKE_TOKEN,
  type FakeState,
} from '../fake-deployment.js';
import type { BenchResult } from '../result.js';
import { readHistoryResult } from './result.js';

type SeedRow = FakeState['chatLogs'][number];

function deps(fetch: CliDeps['fetch'], files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const d: CliDeps = {
    fetch,
    readFile: async (path) => {
      const text = files[path] ?? written[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeFile: async (path, text) => {
      written[path] = text;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => new Date('2026-09-16T12:00:00.000Z'),
    randomId: () => 'deadbeef',
  };
  return { d, out, err, written };
}

let n = 0;
const seed = (over: Partial<SeedRow> = {}): SeedRow => {
  n += 1;
  return {
    id: `seed-${String(n).padStart(3, '0')}`,
    sessionId: `real-${n % 4}`,
    projectSlug: 'qa',
    model: 'gpt-x',
    source: 'web-chat-reply',
    query: 'How many open issues?',
    reply: 'Three.',
    toolCalls: [{ name: 'forge', arguments: '{"argv":["issue"]}', isError: false, durationMs: 1 }],
    iterations: 2,
    durationMs: 3000,
    error: null,
    createdAt: `2026-09-10T00:${String(n).padStart(2, '0')}:00.000Z`,
    ...over,
  };
};

const BENCH_ROOM = 'room-bench-1';
const seededRows = (): SeedRow[] => [
  seed(),
  seed({ reply: null }),
  seed({ query: `${CORRECTIVE_PREFIX} rewrite`, reply: 'Rewritten.' }),
  seed({ source: 'rocketchat', toolCalls: [{ name: 'forge', arguments: '{"argv":["-h"]}' }] }),
  seed({ sessionId: BENCH_ROOM, reply: null }),
  seed({ sessionId: BENCH_ROOM, reply: `see /projects/qa/issues/${DEAD_ISSUE_ID}` }),
];

const runFile = (): string =>
  JSON.stringify({
    at: 'x',
    api: 'https://api.test',
    commit: 'abc',
    version: '0.3.0',
    model: 'fake-model',
    runId: 'r',
    k: 3,
    tasks: [
      {
        id: 't',
        trials: [
          {
            at: 'x',
            pass: true,
            error: null,
            seconds: 1,
            turns: [],
            cleanup: {
              room: { id: BENCH_ROOM, expected: 'deleted', observed: '404', at: 'x' },
              preferences: { expected: null, observed: null, equal: null, at: null },
              auditRowsAdded: 0,
            },
          },
        ],
      },
    ],
  } satisfies BenchResult);

const HISTORY = [
  'history',
  '--api',
  'https://api.test',
  '--project',
  'qa',
  '--from',
  '2026-09-01',
  '--to',
  '2026-09-16',
  '--out',
  '/tmp/h.json',
];
const ENV = { FORGE_BENCH_TOKEN: FAKE_TOKEN };
const fake = (rows = seededRows()) =>
  createFakeDeployment({ script: () => ({ attempts: [{ reply: 'x' }] }), rows });

describe('history', () => {
  it('refuses by name: no credential, a missing flag, a window that is not one', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(HISTORY, {}, d)).toBe(1);
    expect(err[0]).toContain('FORGE_BENCH_TOKEN');
    expect(await main(['history', '--api', 'x'], ENV, d)).toBe(1);
    expect(err[1]).toContain('--project is required');
    expect(
      await main(
        [...HISTORY.slice(0, 6), '2026-09-16', '--to', '2026-09-01', '--out', '/tmp/h.json'],
        ENV,
        d,
      ),
    ).toBe(1);
    expect(err[2]).toBe('--from 2026-09-16 is not before --to 2026-09-01');
    expect(await main([...HISTORY, '--budget-seconds', '0'], ENV, d)).toBe(1);
    expect(err[3]).toBe('--budget-seconds must be a positive number, got 0');
  });

  it('writes one file whose groups and flagged rows match the seeded window', async () => {
    const { d, out, written } = deps(fake().fetch);
    expect(await main(HISTORY, ENV, d)).toBe(0);
    const h = readHistoryResult(written['/tmp/h.json'] ?? '');
    expect(h).toMatchObject({
      api: 'https://api.test',
      commit: 'abc1234',
      budgetSeconds: 60,
      maxIterations: 8,
      resolved: false,
      excludedSessions: [],
      excludedRows: 0,
    });
    expect(h.window).toEqual({
      projectSlug: 'qa',
      from: '2026-09-01',
      to: '2026-09-16',
      source: null,
    });
    expect(h.groups.map((g) => [g.model, g.source, g.rows, g.thin])).toEqual([
      ['gpt-x', 'web-chat-reply', 5, true],
      ['gpt-x', 'rocketchat', 1, true],
    ]);
    const web = h.groups[0];
    expect(web?.modes.unanswered).toEqual({ count: 2, rate: 0.4 });
    expect(web?.modes.screen_repair).toEqual({ count: 1, rate: 0.2 });
    expect(web?.modes.dead_link).toEqual({ count: 0, rate: 0 });
    expect(h.flagged.map((f) => f.modes)).toEqual([
      ['unanswered'],
      ['help_roundtrip'],
      ['screen_repair'],
      ['unanswered'],
    ]);
    expect(out).toEqual([
      'gpt-x / web-chat-reply: 5 rows, 3 flagged (thin)',
      'gpt-x / rocketchat: 1 rows, 1 flagged (thin)',
      'excluded 0 row(s) of 0 bench room(s); wrote /tmp/h.json',
    ]);
  });

  it('--exclude drops the rows of the rooms a run file lists and names them', async () => {
    const { d, out, written } = deps(fake().fetch, { '/tmp/run.json': runFile() });
    expect(await main([...HISTORY, '--exclude', '/tmp/run.json'], ENV, d)).toBe(0);
    const h = readHistoryResult(written['/tmp/h.json'] ?? '');
    expect(h.excludedSessions).toEqual([BENCH_ROOM]);
    expect(h.excludedRows).toBe(2);
    expect(h.groups[0]?.rows).toBe(3);
    expect(h.flagged.some((f) => f.sessionId === BENCH_ROOM)).toBe(false);
    expect(out.at(-1)).toBe('excluded 2 row(s) of 1 bench room(s); wrote /tmp/h.json');
  });

  it('--source reads one door only, and --resolve looks each link up once and can name dead_link', async () => {
    const { fetch, state } = fake();
    const one = deps(fetch);
    expect(await main([...HISTORY, '--source', 'rocketchat'], ENV, one.d)).toBe(0);
    const h1 = readHistoryResult(one.written['/tmp/h.json'] ?? '');
    expect(h1.groups.map((g) => [g.source, g.rows])).toEqual([['rocketchat', 1]]);
    expect(h1.window.source).toBe('rocketchat');

    const two = deps(fetch);
    expect(await main([...HISTORY, '--resolve'], ENV, two.d)).toBe(0);
    const h2 = readHistoryResult(two.written['/tmp/h.json'] ?? '');
    expect(h2.resolved).toBe(true);
    expect(h2.groups[0]?.modes.dead_link).toEqual({ count: 1, rate: 0.2 });
    expect(state.requests.filter((r) => r.path === `/api/issues/${DEAD_ISSUE_ID}`)).toHaveLength(1);
  });

  it('the usage names history and compare-history', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(['nope'], {}, d)).toBe(1);
    expect(err[0]).toContain('bench:assistant history --api');
    expect(err[0]).toContain('bench:assistant compare-history');
  });
});

describe('compare-history', () => {
  it('prints the comparison lines for two files and exits 0', async () => {
    const { fetch } = fake();
    const first = deps(fetch);
    await main(HISTORY, ENV, first.d);
    const file = first.written['/tmp/h.json'] ?? '';
    const { d, out } = deps(fetch, { '/a.json': file, '/b.json': file });
    expect(await main(['compare-history', '/a.json', '/b.json'], {}, d)).toBe(0);
    expect(out[0]).toBe('gpt-x / web-chat-reply');
    expect(out[2]).toBe('    unanswered 2/5 (40.0%), screen_repair 1/5 (20.0%)');
    expect(out.at(-1)).toBe('no differences: same commit, window, budgets and row count');
  });

  it('refuses one file with the usage', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(['compare-history', '/a.json'], {}, d)).toBe(1);
    expect(err[0]).toContain('compare-history needs two history files');
  });
});
