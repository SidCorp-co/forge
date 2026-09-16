/**
 * ISS-1051 — the command line: credentials from the environment or a refusal naming them, an
 * unknown task id refused with the ids shipped, a run that writes one file, and a comparison that
 * prints its lines and exits 0.
 */

import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from './cli.js';
import { createFakeDeployment, FAKE_TOKEN, JUDGE_KEY, JUDGE_URL } from './fake-deployment.js';
import { readHistoryResult } from './history/result.js';
import { isVerdict } from './judge.js';
import { readResult } from './result.js';

function deps(fetch: CliDeps['fetch'], files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const d: CliDeps = {
    fetch,
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeFile: async (path, text) => {
      written[path] = text;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => new Date('2026-09-16T00:00:00.000Z'),
    randomId: () => 'deadbeef',
  };
  return { d, out, err, written };
}

const RUN = ['run', '--api', 'https://api.test', '--project', 'qa', '--out', '/tmp/out.json'];
const fake = () =>
  createFakeDeployment({ script: () => ({ attempts: [{ reply: 'I cannot run tests here.' }] }) });

describe('run', () => {
  it('refuses by name with no credential and reads no file', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(RUN, {}, d)).toBe(1);
    expect(err[0]).toContain(
      'FORGE_BENCH_TOKEN, or both FORGE_BENCH_EMAIL and FORGE_BENCH_PASSWORD',
    );
    expect(await main(RUN, { FORGE_BENCH_EMAIL: 'a@b.c' }, d)).toBe(1);
  });

  it('refuses an unknown task id, listing the ids shipped', async () => {
    const { d, err } = deps(fake().fetch);
    expect(
      await main(
        [...RUN, '--tasks', 'out-of-reach-tests,nope'],
        { FORGE_BENCH_TOKEN: FAKE_TOKEN },
        d,
      ),
    ).toBe(1);
    expect(err[0]).toBe(
      'unknown task id nope; shipped: memory-question, memory-followup, open-issues-linked, one-issue-by-key, preference-bullets, summary-in-style, out-of-reach-tests, vietnamese-count, filing-guidance, preference-restore',
    );
  });

  it('refuses a missing flag and a bad trial count', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(['run', '--api', 'x'], { FORGE_BENCH_TOKEN: FAKE_TOKEN }, d)).toBe(1);
    expect(err[0]).toContain('--project is required');
    expect(await main([...RUN, '--trials', '0'], { FORGE_BENCH_TOKEN: FAKE_TOKEN }, d)).toBe(1);
    expect(err[1]).toBe('--trials must be a positive integer, got 0');
  });

  it('walks the named tasks for the trials asked and writes one result file', async () => {
    const { fetch, state } = fake();
    const { d, out, written } = deps(fetch);
    expect(
      await main(
        [...RUN, '--tasks', 'out-of-reach-tests', '--trials', '2'],
        { FORGE_BENCH_TOKEN: FAKE_TOKEN },
        d,
      ),
    ).toBe(0);
    const result = readResult(written['/tmp/out.json'] ?? '');
    expect(result).toMatchObject({
      api: 'https://api.test',
      commit: 'abc1234',
      version: '0.3.0',
      model: 'fake-model',
      runId: 'deadbeef',
      k: 3,
    });
    expect(result.tasks.map((t) => [t.id, t.trials.length])).toEqual([['out-of-reach-tests', 2]]);
    expect(out).toEqual([
      'run deadbeef against https://api.test (abc1234), project qa',
      'out-of-reach-tests: 2/2 trials passed',
      'wrote /tmp/out.json',
    ]);
    expect(state.rooms.size).toBe(0);
  });

  it('stops scheduling trials when a restore failed, writes what it has and refuses', async () => {
    let patches = 0;
    const { fetch, state } = createFakeDeployment({
      script: () => ({ attempts: [{ reply: '- a\n- b' }] }),
      refuse: (method, path) =>
        method === 'PATCH' && path === '/api/auth/preferences' && ++patches === 2 ? 503 : null,
    });
    const { d, err, written } = deps(fetch);
    const args = [...RUN, '--tasks', 'summary-in-style,out-of-reach-tests', '--trials', '3'];
    expect(await main(args, { FORGE_BENCH_TOKEN: FAKE_TOKEN }, d)).toBe(1);
    expect(err.at(-1)).toContain('summary-in-style trial 1: preference restore failed');
    expect(
      state.requests.filter((r) => r.method === 'POST' && r.path === '/api/conversations'),
    ).toHaveLength(1);
    const partial = readResult(written['/tmp/out.json'] ?? '');
    expect(partial.tasks.map((t) => [t.id, t.trials.length])).toEqual([['summary-in-style', 1]]);
    expect(partial.tasks[0]?.trials[0]?.cleanup.preferences.equal).toBe(false);
    expect(state.prefs.answerStyle).toBe('bullets');
  });

  it('signs in with email and password when no token is set', async () => {
    const { fetch, state } = fake();
    const { d } = deps(fetch);
    expect(
      await main(
        [...RUN, '--tasks', 'out-of-reach-tests', '--trials', '1'],
        { FORGE_BENCH_EMAIL: 'a@b.c', FORGE_BENCH_PASSWORD: 'pw' },
        d,
      ),
    ).toBe(0);
    expect(state.requests[0]).toMatchObject({ method: 'POST', path: '/api/auth/local' });
  });
});

describe('compare', () => {
  it('prints the comparison lines for two files and exits 0', async () => {
    const { fetch } = fake();
    const first = deps(fetch);
    await main(
      [...RUN, '--tasks', 'out-of-reach-tests', '--trials', '3'],
      { FORGE_BENCH_TOKEN: FAKE_TOKEN },
      first.d,
    );
    const file = first.written['/tmp/out.json'] ?? '';
    const { d, out } = deps(fetch, { '/a.json': file, '/b.json': file });
    expect(await main(['compare', '/a.json', '/b.json'], {}, d)).toBe(0);
    expect(out[0]).toBe('out-of-reach-tests');
    expect(out[1]).toBe('  before: pass^3 100% · pass@3 100% · 3/3 trials passed');
    expect(out.at(-1)).toBe(
      'differences: none (same commit, api, model, judge, k and trial count)',
    );
  });

  it('refuses one file and prints the usage', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(['compare', '/a.json'], {}, d)).toBe(1);
    expect(err[0]).toContain('compare needs two result files');
    expect(await main([], {}, d)).toBe(1);
  });
});

const JUDGE_ENV = {
  FORGE_BENCH_TOKEN: FAKE_TOKEN,
  FORGE_BENCH_JUDGE_URL: JUDGE_URL,
  FORGE_BENCH_JUDGE_KEY: JUDGE_KEY,
};
const verdict = (served: 'yes' | 'partial' | 'no'): string =>
  JSON.stringify({
    intent: 'run the tests',
    served,
    reason: 'r',
    quote: served === 'no' ? '' : 'cannot run tests',
  });
const TASK = ['--tasks', 'out-of-reach-tests'];
const judgePosts = (state: ReturnType<typeof fake>['state']) =>
  state.requests.filter((r) => r.path === '/v1/chat/completions');
const rooms = (state: ReturnType<typeof fake>['state']) =>
  state.requests.filter((r) => r.method === 'POST' && r.path === '/api/conversations');

describe('run --judge', () => {
  it('refuses by name before any trial when the judge variables are absent', async () => {
    const { fetch, state } = fake();
    const { d, err } = deps(fetch);
    expect(
      await main([...RUN, ...TASK, '--judge', 'j'], { FORGE_BENCH_TOKEN: FAKE_TOKEN }, d),
    ).toBe(1);
    expect(err[0]).toContain('set FORGE_BENCH_JUDGE_URL and FORGE_BENCH_JUDGE_KEY');
    expect(rooms(state)).toHaveLength(0);
  });

  it('stores the verdict beside every turn, names the judge in the header, prints the tally, and grades as without it', async () => {
    const script = () => ({ attempts: [{ reply: 'I cannot run tests here.' }] });
    const judged = createFakeDeployment({ script, judge: () => verdict('yes') });
    const plain = createFakeDeployment({ script });
    const a = deps(judged.fetch);
    const b = deps(plain.fetch);
    const args = [...RUN, ...TASK, '--trials', '2'];
    expect(await main([...args, '--judge', 'judge-model'], JUDGE_ENV, a.d)).toBe(0);
    expect(await main(args, { FORGE_BENCH_TOKEN: FAKE_TOKEN }, b.d)).toBe(0);
    const withJudge = readResult(a.written['/tmp/out.json'] ?? '');
    const without = readResult(b.written['/tmp/out.json'] ?? '');
    expect(withJudge.judge).toEqual({ model: 'judge-model' });
    expect(without.judge).toBeUndefined();
    const turns = withJudge.tasks[0]?.trials.flatMap((t) => t.turns) ?? [];
    expect(turns).toHaveLength(2);
    for (const turn of turns)
      expect(turn.judge && isVerdict(turn.judge) && turn.judge.served).toBe('yes');
    const strip = (r: typeof withJudge) =>
      r.tasks.map((t) =>
        t.trials.map((trial) => trial.turns.map(({ judge: _j, ...rest }) => rest)),
      );
    expect(strip(withJudge)).toEqual(strip(without));
    expect(
      without.tasks.flatMap((t) => t.trials.flatMap((x) => x.turns)).some((t) => 'judge' in t),
    ).toBe(false);
    expect(a.out).toContain(
      'out-of-reach-tests: judge yes 2/2, partial 0/2, no 0/2, unreadable 0/2',
    );
    const posts = judgePosts(judged.state);
    expect(posts).toHaveLength(2);
    expect(posts.every((r) => r.model === 'judge-model')).toBe(true);
  });

  it('a judge that is the model under test: no judge call, the refused trial kept whole, no further trial, exit 1', async () => {
    const { fetch, state } = createFakeDeployment({
      script: () => ({ attempts: [{ reply: 'I cannot run tests here.' }] }),
      judge: () => verdict('yes'),
    });
    const { d, err, written } = deps(fetch);
    expect(
      await main([...RUN, ...TASK, '--trials', '3', '--judge', 'fake-model'], JUDGE_ENV, d),
    ).toBe(1);
    expect(err.at(-1)).toContain(
      'out-of-reach-tests trial 1: judge fake-model is the model under test (trail rows name fake-model); no turn judged',
    );
    expect(judgePosts(state)).toHaveLength(0);
    expect(rooms(state)).toHaveLength(1);
    const partial = readResult(written['/tmp/out.json'] ?? '');
    const trial = partial.tasks[0]?.trials[0];
    expect(partial.tasks.map((t) => [t.id, t.trials.length])).toEqual([['out-of-reach-tests', 1]]);
    expect(trial?.pass).toBe(true);
    expect(trial?.turns[0]).not.toHaveProperty('judge');
    expect(trial?.cleanup.room.id).not.toBe('');
    expect(trial?.cleanup.room.observed).toBe('404');
    expect(state.rooms.size).toBe(0);
  });
});

describe('ladder', () => {
  const twoRuns = async () => {
    const { fetch } = fake();
    const a = deps(fetch);
    await main([...RUN, ...TASK, '--trials', '3'], { FORGE_BENCH_TOKEN: FAKE_TOKEN }, a.d);
    const passing = a.written['/tmp/out.json'] ?? '';
    const failing = createFakeDeployment({
      script: () => ({ attempts: [{ reply: null }], deliver: null }),
    });
    const b = deps(failing.fetch);
    await main([...RUN, ...TASK, '--trials', '3'], { FORGE_BENCH_TOKEN: FAKE_TOKEN }, b.d);
    return { passing, failing: b.written['/tmp/out.json'] ?? '' };
  };

  it('refuses with the usage when no run file is given, and refuses a file that is not a run file by name', async () => {
    const { d, err } = deps(fake().fetch, { '/x.json': '{"not":"a run"}' });
    expect(await main(['ladder'], {}, d)).toBe(1);
    expect(err[0]).toContain('ladder needs at least one run file');
    expect(await main(['ladder', '/x.json'], {}, d)).toBe(1);
    expect(err[1]).toBe('/x.json lacks at');
    expect(await main(['ladder', '/x.json', '--out'], {}, d)).toBe(1);
    expect(err[2]).toBe('--out needs a value');
  });

  it('prints the ranked run table, the window table after it, and writes the Markdown to --out', async () => {
    const { passing, failing } = await twoRuns();
    const h = deps(fake().fetch);
    const history = JSON.stringify({
      ...readHistoryResult(
        JSON.stringify({
          at: 'x',
          api: 'a',
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
        }),
      ),
    });
    void h;
    const { d, out, written } = deps(fake().fetch, {
      '/good.json': passing,
      '/bad.json': failing,
      '/h.json': history,
    });
    expect(
      await main(
        ['ladder', '/bad.json', '/good.json', '--history', '/h.json', '--out', '/l.md'],
        {},
        d,
      ),
    ).toBe(0);
    expect(out[0]).toBe('runs');
    const rows = out.filter((l) => /^\d+\s/.test(l));
    expect(rows[0]).toContain('/good.json');
    expect(rows[0]).toMatch(/100\.0\s+out-of-reach-tests 100%/);
    expect(rows[1]).toContain('/bad.json');
    expect(rows[1]).toMatch(/0\.0\s+out-of-reach-tests 0%/);
    expect(rows[0]).toContain('partial (1 of 10 tasks)');
    expect(out.indexOf('history windows')).toBeGreaterThan(out.indexOf('runs'));
    expect(out.at(-1)).toBe('wrote /l.md');
    expect(written['/l.md']).toContain('### Runs');
    expect(written['/l.md']).toContain('| 1 | /good.json |');
  });
});
