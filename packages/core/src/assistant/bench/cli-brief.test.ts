/**
 * ISS-1051 — the command line: credentials from the environment or a refusal naming them, an
 * unknown task id refused with the ids shipped, a run that writes one file, and a comparison that
 * prints its lines and exits 0.
 */

import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from './cli.js';
import {
  createFakeDeployment,
  FAKE_CLOSED,
  FAKE_ISSUE,
  FAKE_PROJECT,
  FAKE_TOKEN,
} from './fake-deployment.js';
import { readResult } from './result.js';

function deps(fetch: CliDeps['fetch'], files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const made: string[] = [];
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
    mkdir: async (path) => {
      made.push(path);
    },
    writeNew: async (path, text) => {
      if (written[path] !== undefined)
        throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
      written[path] = text;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => new Date('2026-09-16T00:00:00.000Z'),
    randomId: () => 'deadbeef',
  };
  return { d, out, err, written, made };
}

const RUN = ['run', '--api', 'https://api.test', '--project', 'qa', '--out', '/tmp/out.json'];
const fake = () =>
  createFakeDeployment({ script: () => ({ attempts: [{ reply: 'I cannot run tests here.' }] }) });

describe('the project brief a run is judged against (ISS-1066)', () => {
  it('writes the project block, brief and read time into the result file', async () => {
    const { fetch } = fake();
    const { d, written } = deps(fetch);
    expect(
      await main(
        [...RUN, '--tasks', 'out-of-reach-tests', '--trials', '1'],
        { FORGE_BENCH_TOKEN: FAKE_TOKEN },
        d,
      ),
    ).toBe(0);
    const result = readResult(written['/tmp/out.json'] ?? '');
    expect(result.project?.slug).toBe('qa');
    expect(result.project?.id).toBe(FAKE_PROJECT.id);
    expect(result.project?.readAt).toBe('2026-09-16T00:00:00.000Z');
    expect(result.project?.brief).toContain('QA Project (qa)');
    expect(result.project?.brief).toContain('open → confirmed → approved');
  });

  it('records a task the project cannot be asked, runs no trial for it, and charges it to nothing', async () => {
    // The QA fake holds one open issue, one closed and one at needs_info; drop the needs_info one
    // and `project-waiting-issue` is a question this project cannot be asked (ISS-1066).
    const deployment = createFakeDeployment({
      script: () => ({ attempts: [{ reply: 'nothing is waiting.' }] }),
      issues: [FAKE_ISSUE, FAKE_CLOSED],
    });
    const { d, out, written } = deps(deployment.fetch);
    expect(
      await main(
        [...RUN, '--tasks', 'project-waiting-issue', '--trials', '3'],
        { FORGE_BENCH_TOKEN: FAKE_TOKEN },
        d,
      ),
    ).toBe(0);
    expect(out).toContain(
      'project-waiting-issue: not applicable — the project holds no issue waiting on information',
    );
    const result = readResult(written['/tmp/out.json'] ?? '');
    expect(result.tasks[0]?.trials).toEqual([]);
    expect(result.tasks[0]?.notApplicable).toBe(
      'the project holds no issue waiting on information',
    );
    // cm:guard no room was opened for it: the old path ran three trials, failed all three on a
    // refusal that was RIGHT, and left the capability reading 0/3
    expect(deployment.state.rooms.size).toBe(0);
    const summary = result.capabilities?.[0];
    expect(summary?.tasks).toEqual([]);
    expect(summary?.score).toBeNull();
    expect(summary?.fullTasks).toBe(0);
    expect(summary?.notApplicable).toEqual([
      {
        id: 'project-waiting-issue',
        why: 'the project holds no issue waiting on information',
      },
    ]);
  });

  it('refuses the whole run by name, before any room, where the knowledge cannot be read', async () => {
    const deployment = createFakeDeployment({
      script: () => ({ attempts: [{ reply: 'x' }] }),
      knowledgeStatus: 403,
    });
    const { d, err } = deps(deployment.fetch);
    expect(
      await main([...RUN, '--tasks', 'out-of-reach-tests'], { FORGE_BENCH_TOKEN: FAKE_TOKEN }, d),
    ).toBe(1);
    expect(err[0]).toContain("cannot read this project's knowledge");
    expect(err[0]).toContain('403');
    expect(deployment.state.rooms.size).toBe(0);
  });

  it('refuses a comparison of two projects unless --across-projects is given', async () => {
    const { d, err, out } = deps(fake().fetch);
    const withProject = (slug: string): string =>
      JSON.stringify({
        at: '2026-09-17T00:00:00.000Z',
        api: 'https://beta',
        commit: 'abc',
        version: '0.3.0',
        model: 'm',
        runId: 'r',
        k: 3,
        tasks: [],
        project: { id: `id-${slug}`, slug, brief: 'b', readAt: '2026-09-17T00:00:00.000Z' },
      });
    d.readFile = async (path: string) =>
      path === '/a.json' ? withProject('qa') : withProject('forge-plugin');
    expect(await main(['compare', '/a.json', '/b.json'], {}, d)).toBe(1);
    expect(err.at(-1)).toContain('different projects');
    expect(err.at(-1)).toContain('forge-plugin');
    expect(await main(['compare', '/a.json', '/b.json', '--across-projects'], {}, d)).toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });
});
