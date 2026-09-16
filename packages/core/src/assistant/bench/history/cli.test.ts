/**
 * ISS-1053 - the verbs over the scripted deployment: refusals by name, one file written from a
 * seeded window, the bench rooms dropped by --exclude, --source and --resolve, and compare-history
 * printing and exiting 0.
 */

import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../cli.js';
import { createFakeDeployment, DEAD_ISSUE_ID, JUDGE_KEY, JUDGE_URL } from '../fake-deployment.js';
import { BENCH_ROOM, deps, ENV, fake, HISTORY, runFile, seededRows } from './cli-ground.js';
import { readHistoryResult } from './result.js';

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
      'excluded 0 row(s) of 0 bench room(s) by run file and 0 row(s) of 0 by task message; wrote /tmp/h.json',
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
    expect(out.at(-1)).toBe(
      'excluded 2 row(s) of 1 bench room(s) by run file and 0 row(s) of 0 by task message; wrote /tmp/h.json',
    );
  });

  it('--exclude with --resolve never looks up a link inside an excluded room', async () => {
    const { fetch, state } = fake();
    const { d, err, written } = deps(fetch, { '/tmp/run.json': runFile() });
    expect(
      await main([...HISTORY, '--exclude', '/tmp/run.json', '--resolve'], ENV, d),
      err.join('\n'),
    ).toBe(0);
    const h = readHistoryResult(written['/tmp/h.json'] ?? '');
    expect(h.resolved).toBe(true);
    expect(h.excludedRows).toBe(2);
    expect(h.groups[0]?.modes.dead_link).toEqual({ count: 0, rate: 0 });
    expect(state.requests.filter((r) => r.path === `/api/issues/${DEAD_ISSUE_ID}`)).toHaveLength(0);
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
    expect(out).toContain('no differences: same commit, window, budgets, judge and row count');
    expect(out.indexOf('advice:')).toBeGreaterThan(
      out.indexOf('no differences: same commit, window, budgets, judge and row count'),
    );
    expect(out.at(-1)).toContain(
      'help_roundtrip 1/1 (100%) above 10% -> guides/assistant-method-guide.ts:ASSISTANT_METHOD_GUIDE',
    );
  });

  it('refuses one file with the usage', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(['compare-history', '/a.json'], {}, d)).toBe(1);
    expect(err[0]).toContain('compare-history needs two history files');
  });
});

const JUDGE_ENV = { ...ENV, FORGE_BENCH_JUDGE_URL: JUDGE_URL, FORGE_BENCH_JUDGE_KEY: JUDGE_KEY };
const say = (served: 'yes' | 'partial' | 'no', quote = ''): string =>
  JSON.stringify({ intent: 'count the open issues', served, reason: 'r', quote });
/** Yes for a real answer, no for none, and word salad for the repaired reply. */
const scriptedJudge = ({ reply }: { reply: string | null }): string => {
  if (reply === null) return say('no');
  if (reply === 'Rewritten.') return 'salad';
  return say('yes', 'Three.');
};
const judgeFake = (rows = seededRows()) =>
  createFakeDeployment({
    script: () => ({ attempts: [{ reply: 'x' }] }),
    rows,
    judge: scriptedJudge,
  });

describe('history --judge', () => {
  it('refuses --judge-sample without --judge, and a sample that is not a positive integer', async () => {
    const { d, err } = deps(judgeFake().fetch);
    expect(await main([...HISTORY, '--judge-sample', '5'], JUDGE_ENV, d)).toBe(1);
    expect(err[0]).toBe('--judge-sample needs --judge <model>');
    expect(await main([...HISTORY, '--judge', 'j', '--judge-sample', '2.5'], JUDGE_ENV, d)).toBe(1);
    expect(err[1]).toBe('--judge-sample must be a positive integer, got 2.5');
    expect(await main([...HISTORY, '--judge', 'j'], ENV, d)).toBe(1);
    expect(err[2]).toContain('set FORGE_BENCH_JUDGE_URL and FORGE_BENCH_JUDGE_KEY');
  });

  it('refuses by name before any call when the judge is a model the window names', async () => {
    const { fetch, state } = judgeFake();
    const { d, err } = deps(fetch);
    expect(await main([...HISTORY, '--judge', 'gpt-x'], JUDGE_ENV, d)).toBe(1);
    expect(err[0]).toBe(
      'judge gpt-x is a model under test (group gpt-x / web-chat-reply); no row judged',
    );
    expect(state.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(0);
  });

  it('judges the newest sample of kept rows, records sample and rows, tallies per group with agreement, and grades as without it', async () => {
    const rows = seededRows();
    const judged = judgeFake(rows);
    const plain = createFakeDeployment({ script: () => ({ attempts: [{ reply: 'x' }] }), rows });
    const a = deps(judged.fetch, { '/tmp/run.json': runFile() });
    const b = deps(plain.fetch, { '/tmp/run.json': runFile() });
    const args = [...HISTORY, '--exclude', '/tmp/run.json'];
    expect(
      await main([...args, '--judge', 'judge-model', '--judge-sample', '3'], JUDGE_ENV, a.d),
    ).toBe(0);
    expect(await main(args, ENV, b.d)).toBe(0);
    const withJudge = readHistoryResult(a.written['/tmp/h.json'] ?? '');
    const without = readHistoryResult(b.written['/tmp/h.json'] ?? '');
    const { judge, ...rest } = withJudge;
    expect(rest).toEqual(without);
    expect(without.judge).toBeUndefined();
    expect(judge?.model).toBe('judge-model');
    expect(judge?.sample).toBe(3);
    expect(
      judge?.rows.map((r) => [
        r.source,
        r.modes,
        'error' in r.judge ? 'unreadable' : r.judge.served,
      ]),
    ).toEqual([
      ['rocketchat', ['help_roundtrip'], 'yes'],
      ['web-chat-reply', ['screen_repair'], 'unreadable'],
      ['web-chat-reply', ['unanswered'], 'no'],
    ]);
    expect(
      judge?.rows.every((r) => r.chatLogId.startsWith('seed-') && r.sessionId !== BENCH_ROOM),
    ).toBe(true);
    expect(judge?.groups).toEqual([
      {
        model: 'gpt-x',
        source: 'rocketchat',
        tally: { judged: 1, yes: 1, partial: 0, no: 0, unreadable: 0 },
      },
      {
        model: 'gpt-x',
        source: 'web-chat-reply',
        tally: { judged: 2, yes: 0, partial: 0, no: 1, unreadable: 1 },
      },
    ]);
    expect(judge?.agreement).toEqual({
      ruleFailed: { judged: 1, no: 1 },
      clean: { judged: 0, yes: 0 },
    });
    expect(judged.state.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(3);
    expect(a.out).toContain(
      'judge judge-model read 3 of 3 asked: judge yes 1/3, partial 0/3, no 1/3, unreadable 1/3',
    );
  });

  it('the sample defaults to 40 and a smaller window is judged whole', async () => {
    const { d, written } = deps(judgeFake().fetch, { '/tmp/run.json': runFile() });
    expect(
      await main(
        [...HISTORY, '--exclude', '/tmp/run.json', '--judge', 'judge-model'],
        JUDGE_ENV,
        d,
      ),
    ).toBe(0);
    const h = readHistoryResult(written['/tmp/h.json'] ?? '');
    expect(h.judge?.sample).toBe(40);
    expect(h.judge?.rows).toHaveLength(4);
  });
});

describe('harvest', () => {
  const judged = (rows: unknown[]) =>
    JSON.stringify({
      at: 'x',
      api: 'https://api.test',
      commit: 'c',
      version: 'v',
      window: { projectSlug: 'qa', from: '2026-09-01', to: '2026-09-02', source: null },
      budgetSeconds: 60,
      maxIterations: 8,
      resolved: false,
      excludedSessions: [],
      excludedRows: 0,
      groups: [],
      flagged: [],
      judge: {
        model: 'cx/judge',
        sample: rows.length,
        rows,
        groups: [],
        agreement: { ruleFailed: { judged: 0, no: 0 }, clean: { judged: 0, yes: 0 } },
      },
    });
  const row = (chatLogId: string, served: string, intent: string, query: string) => ({
    chatLogId,
    sessionId: 'room',
    createdAt: 'x',
    model: 'm',
    source: 'web',
    modes: [],
    judge: { intent, served, reason: 'r', quote: '' },
    query,
    askedBy: null,
  });

  it('writes every candidate under --out, prints what it wrote and skipped, exits 0 and never calls the deployment', async () => {
    let calls = 0;
    const fetch: CliDeps['fetch'] = async () => {
      calls += 1;
      throw new Error('the deployment must not be called');
    };
    const { d, out, err, written, made } = deps(fetch, {
      '/h.json': judged([
        row(
          '8646c47d-0000-4000-8000-000000000001',
          'no',
          'Archive the room and prove the message survived.',
          'Archive this room and show me the message is still there.',
        ),
        row('3333aaaa-0000-4000-8000-000000000003', 'yes', 'x', 'How many open issues are there?'),
      ]),
    });
    expect(await main(['harvest', '/h.json', '--out', '/tmp/cands/'], {}, d)).toBe(0);
    expect(calls).toBe(0);
    expect(made).toEqual(['/tmp/cands/']);
    expect(Object.keys(written)).toEqual([
      '/tmp/cands/archive-room-prove-message-survived-8646c47d.ts',
    ]);
    expect(written['/tmp/cands/archive-room-prove-message-survived-8646c47d.ts']).toContain(
      'export const archiveRoomProveMessageSurvived8646c47d: Task = {',
    );
    expect(out).toEqual([
      'wrote 1 candidate(s) to /tmp/cands/',
      '  archive-room-prove-message-survived-8646c47d.ts — Archive the room and prove the message survived.',
      'skipped 1:',
      '  3333aaaa — judged yes',
    ]);
    expect(err).toEqual([]);
  });

  it('never overwrites a candidate: a second harvest into the same directory is refused by path and the edited file stands', async () => {
    const h = judged([
      row(
        '8646c47d-0000-4000-8000-000000000001',
        'no',
        'Archive the room and prove the message survived.',
        'Archive this room and show me the message is still there.',
      ),
    ]);
    const { d, err, written } = deps(fake().fetch, { '/h.json': h });
    expect(await main(['harvest', '/h.json', '--out', '/tmp/cands'], {}, d)).toBe(0);
    const path = '/tmp/cands/archive-room-prove-message-survived-8646c47d.ts';
    written[path] = 'a person wrote the checks here';
    expect(await main(['harvest', '/h.json', '--out', '/tmp/cands'], {}, d)).toBe(1);
    expect(err[0]).toBe(
      `${path} exists and a candidate is never overwritten; move or delete it first (nothing after it was written)`,
    );
    expect(written[path]).toBe('a person wrote the checks here');
  });

  it('refuses with the usage when the file or --out is missing, and by name a file with no judge', async () => {
    const plain = JSON.stringify({ ...JSON.parse(judged([])), judge: undefined });
    const { d, err } = deps(fake().fetch, { '/p.json': plain });
    expect(await main(['harvest'], {}, d)).toBe(1);
    expect(err[0]).toContain('harvest needs a history file');
    expect(err[0]).toContain('bench:assistant harvest <history.json> --out <dir>');
    expect(await main(['harvest', '/p.json'], {}, d)).toBe(1);
    expect(err[1]).toContain('--out is required');
    expect(await main(['harvest', '/p.json', '--out', '/tmp/x'], {}, d)).toBe(1);
    expect(err[2]).toBe('/p.json carries no judge; run history --judge on the window first');
  });
});
