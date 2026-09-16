/**
 * ISS-1051 — the command line: credentials from the environment or a refusal naming them, an
 * unknown task id refused with the ids shipped, a run that writes one file, and a comparison that
 * prints its lines and exits 0.
 */

import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from './cli.js';
import { createFakeDeployment, FAKE_TOKEN } from './fake-deployment.js';
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
    expect(out.at(-1)).toBe('differences: none (same commit, api, model, k and trial count)');
  });

  it('refuses one file and prints the usage', async () => {
    const { d, err } = deps(fake().fetch);
    expect(await main(['compare', '/a.json'], {}, d)).toBe(1);
    expect(err[0]).toContain('compare needs two result files');
    expect(await main([], {}, d)).toBe(1);
  });
});
