// The merge check runs the change's kept probes (REQ-36 BC-1, BC-9; ISS-472 round 4): a command
// probe is spawned in the checkout and judged on its exit code and stdout, a request probe is sent
// to the origin serving the change where it can be, and what cannot run is said by name. A kept
// probe that did not run, or an observable criterion keeping none, is MERGE_PROBE_MISSING; one that
// answered something else is MERGE_PROBE_RED.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  criteriaOf,
  originOf,
  PROBE_ORIGIN_ENV,
  probeRefusalLines,
  probesOwed,
  readProbesFlag,
  runCommandProbe,
  runProbes,
  runRequestProbe,
} from './merge-probes.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'merge-probes-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const node = (script, expect = { exitCode: 0 }) => ({
  id: `p-${Math.random().toString(16).slice(2)}`,
  kind: 'command',
  command: { argv: [process.execPath, '-e', script] },
  expect,
});

const request = (over = {}, expect = { status: 200 }) => ({
  id: 'p-request',
  kind: 'request',
  request: { method: 'GET', path: '/api/health', as: 'anonymous', ...over },
  expect,
});

const answering = (status, body) => async () => new Response(body, { status });

describe('the probes a merge owes', () => {
  it('runs every kept probe, and names an observable criterion that keeps none', () => {
    const probe = node('1');
    const owed = probesOwed([
      { n: 1, class: 'observable', probe },
      { n: 2, class: 'observable', probe: null },
      { n: 3, class: 'code_property', probe: null },
      { n: 4, class: null, probe: null },
      { n: 5, class: null, probe },
    ]);
    expect(owed.runs.map((r) => r.criterion)).toEqual([1, 5]);
    expect(owed.missing).toEqual([{ criterion: 2, why: 'it is observable and keeps no probe' }]);
  });

  it('reads the saved criteria read, and refuses any other file by name', () => {
    const ok = criteriaOf(
      JSON.stringify({ criteria: [{ n: 3, class: 'observable', probe: null, statement: 'x' }] }),
      'c.json',
    );
    expect(ok.criteria).toEqual([{ n: 3, class: 'observable', probe: null }]);
    expect(criteriaOf('{', 'c.json').refusal).toContain('is not JSON');
    expect(criteriaOf('{"items":[]}', 'c.json').refusal).toContain('holds no `criteria` list');
    expect(criteriaOf('{"criteria":[{"class":null}]}', 'c.json').refusal).toContain(
      'criteria[0] has no criterion number',
    );
    expect(
      criteriaOf('{"criteria":[{"n":1,"probe":{"kind":"command"}}]}', 'c.json').refusal,
    ).toContain("criterion 1's probe has no `id`");
    expect(readProbesFlag('none')).toEqual({ criteria: null });
    expect(readProbesFlag(join(ROOT, 'absent.json')).refusal).toContain('cannot be read (ENOENT)');
    const file = join(ROOT, 'criteria.json');
    writeFileSync(file, JSON.stringify({ criteria: [] }));
    expect(readProbesFlag(file)).toEqual({ criteria: [] });
  });

  it('takes an http(s) origin as --probe-origin, and nothing else', () => {
    expect(originOf('http://127.0.0.1:3100')).toEqual({ origin: 'http://127.0.0.1:3100' });
    expect(originOf('http://127.0.0.1:3100/').origin).toBe('http://127.0.0.1:3100');
    expect(originOf('localhost').refusal).toContain('not a URL');
    expect(originOf('ftp://x').refusal).toContain('http(s) origin');
    expect(originOf('https://u:p@x').refusal).toContain('without a credential');
    expect(originOf('https://x/api').refusal).toContain('has a path');
  });
});

describe('a command probe runs in the checkout', () => {
  it('holds where its exit code and every stdout string match', () => {
    const out = runCommandProbe(
      node("console.log('merge probe held')", { exitCode: 0, stdoutIncludes: ['merge', 'held'] }),
      { root: ROOT, origin: null },
    );
    expect(out.result).toBe('pass');
  });

  it('is red on another exit code, naming both', () => {
    const out = runCommandProbe(node('process.exit(3)'), { root: ROOT, origin: null });
    expect(out.result).toBe('fail');
    expect(out.detail).toBe('it exited 3, expected 0');
  });

  it('is red where its stdout lacks a string it expects, naming it', () => {
    const out = runCommandProbe(
      node("console.log('other')", { exitCode: 0, stdoutIncludes: ['held'] }),
      { root: ROOT, origin: null },
    );
    expect(out.result).toBe('fail');
    expect(out.detail).toBe('its stdout lacks "held"');
  });

  it('is red where its program cannot start', () => {
    const probe = {
      id: 'x',
      kind: 'command',
      command: { argv: ['no-such-program-472'] },
      expect: { exitCode: 0 },
    };
    const spawn = () => ({
      status: null,
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    });
    const out = runCommandProbe(probe, { root: ROOT, origin: null, spawn });
    expect(out.result).toBe('fail');
    expect(out.detail).toContain('ENOENT');
  });

  it('reads the origin from FORGE_PROBE_ORIGIN, set only to --probe-origin', () => {
    const echo = node(`process.stdout.write(String(process.env.${PROBE_ORIGIN_ENV}))`, {
      exitCode: 0,
      stdoutIncludes: ['http://127.0.0.1:3999'],
    });
    const env = { ...process.env, [PROBE_ORIGIN_ENV]: 'https://forge-dev.example' };
    expect(runCommandProbe(echo, { root: ROOT, origin: 'http://127.0.0.1:3999', env }).result).toBe(
      'pass',
    );
    const unset = runCommandProbe(
      node(`process.stdout.write(String(process.env.${PROBE_ORIGIN_ENV}))`, {
        exitCode: 0,
        stdoutIncludes: ['undefined'],
      }),
      { root: ROOT, origin: null, env },
    );
    expect(unset.result).toBe('pass');
    expect(unset.note).toBe(`${PROBE_ORIGIN_ENV} unset: no --probe-origin given`);
  });

  it('runs at its cwd inside the checkout', () => {
    const calls = [];
    const spawn = (_cmd, _args, opts) => {
      calls.push(opts.cwd);
      return { status: 0, stdout: '' };
    };
    runCommandProbe(
      { ...node('1'), command: { argv: ['x'], cwd: 'packages/core' } },
      { root: '/repo', origin: null, spawn },
    );
    expect(calls).toEqual(['/repo/packages/core']);
  });
});

describe('a request probe goes to the origin serving the change', () => {
  it('cannot run with no origin, as the replayer, or for a service, and says which', async () => {
    expect(await runRequestProbe(request(), { origin: null })).toMatchObject({
      result: 'none',
      detail: 'could not run: no --probe-origin names a build of the change to send it to',
    });
    expect(
      (await runRequestProbe(request({ as: 'replayer' }), { origin: 'http://h' })).detail,
    ).toContain('the merge check holds none');
    expect(
      (await runRequestProbe(request({ service: 'api' }), { origin: 'http://h' })).detail,
    ).toContain('names service `api`');
  });

  it('holds on the status and body it expects, and is red otherwise', async () => {
    const probe = request({}, { status: 200, bodyIncludes: ['"ok":true'] });
    expect(
      (
        await runRequestProbe(probe, {
          origin: 'http://h',
          fetchImpl: answering(200, '{"ok":true}'),
        })
      ).result,
    ).toBe('pass');
    const status = await runRequestProbe(probe, {
      origin: 'http://h',
      fetchImpl: answering(500, '{"ok":true}'),
    });
    expect(status).toMatchObject({ result: 'fail', detail: 'it answered 500, expected 200' });
    const body = await runRequestProbe(probe, {
      origin: 'http://h',
      fetchImpl: answering(200, '{}'),
    });
    expect(body).toMatchObject({ result: 'fail', detail: 'its body lacks "\\"ok\\":true"' });
  });

  it('sends its path on the origin given', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push([url, init.method]);
      return new Response('', { status: 200 });
    };
    await runRequestProbe(request(), { origin: 'http://127.0.0.1:3100', fetchImpl });
    expect(seen).toEqual([['http://127.0.0.1:3100/api/health', 'GET']]);
  });

  it('did not run where the origin does not answer', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    };
    const out = await runRequestProbe(request(), { origin: 'http://127.0.0.1:1', fetchImpl });
    expect(out).toMatchObject({ result: 'none' });
    expect(out.detail).toContain('ECONNREFUSED');
  });
});

describe('a probe run, as the report carries it', () => {
  it('writes one probes check per kept probe, bound to it, and names what is missing or red', async () => {
    const held = node("console.log('ok')");
    const broken = node('process.exit(1)');
    const out = await runProbes(
      [
        { n: 1, class: 'observable', probe: held },
        { n: 2, class: 'observable', probe: broken },
        { n: 3, class: 'observable', probe: null },
        { n: 4, class: 'observable', probe: request() },
      ],
      { root: ROOT, origin: null },
    );
    expect(out.checks.map((c) => [c.kind, c.name, c.scope, c.result])).toEqual([
      ['probes', 'probes', 'criterion 1', 'pass'],
      ['probes', 'probes', 'criterion 2', 'fail'],
      ['probes', 'probes', 'criterion 4', 'none'],
    ]);
    expect(out.bindings).toEqual([
      { criterion: 1, probe: held.id, check: out.checks[0].id },
      { criterion: 2, probe: broken.id, check: out.checks[1].id },
      { criterion: 4, probe: 'p-request', check: out.checks[2].id },
    ]);
    expect(out.missing.map((m) => m.criterion)).toEqual([3, 4]);
    expect(out.red.map((r) => r.criterion)).toEqual([2]);
    const lines = probeRefusalLines(out);
    expect(lines[0]).toMatch(
      /^MERGE_PROBE_MISSING — criterion 3: it is observable and keeps no probe; criterion 4: could not run/,
    );
    expect(lines[1]).toBe('MERGE_PROBE_RED — criterion 2: it exited 1, expected 0');
  });

  it('says so where the issue keeps no probe, or the run names no issue', async () => {
    const none = await runProbes([{ n: 1, class: 'code_property', probe: null }], { root: ROOT });
    expect(none.checks.map((c) => [c.scope, c.result, c.command])).toEqual([
      ['issue', 'none', 'the issue keeps no probe to run'],
    ]);
    expect(probeRefusalLines(none)).toEqual([]);
    const unnamed = await runProbes(null, { root: ROOT });
    expect(unnamed.checks.map((c) => [c.scope, c.result, c.command])).toEqual([
      ['no issue', 'none', '--probes none'],
    ]);
    expect(unnamed.bindings).toEqual([]);
  });
});
