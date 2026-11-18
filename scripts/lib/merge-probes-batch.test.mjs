// One merge check for a batch (ISS-1294): `--probes <issue id>=<file>` once per issue the batch lands
// runs each issue's kept probes, and the report carries each one's probes and standing under its id,
// while a single `--probes <file>` and `--probes none` read and report as before.

import { describe, expect, it } from 'vitest';
import { reportOf } from './merge-check.mjs';
import { probeRefusalLines } from './merge-probes.mjs';
import { probeStandingLines, readProbesFlags, runProbesRead } from './merge-probes-batch.mjs';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CARRIED = 'c'.repeat(40);

/** A file reader over a fixed set of criteria reads, standing in for `readProbesFlag`. */
const files = {
  'a.json': [
    {
      n: 1,
      class: 'observable',
      probe: {
        id: 'pa',
        kind: 'command',
        command: { argv: ['true'] },
        expect: { exitCode: 0 },
      },
      latest: null,
    },
  ],
  'b.json': [
    {
      n: 2,
      class: 'observable',
      probe: null,
      latest: { id: 'vb', verdict: 'pass', identityKind: 'commit', commitSha: CARRIED },
    },
  ],
};
const read = (path) =>
  path === 'none'
    ? { criteria: null }
    : files[path]
      ? { criteria: files[path] }
      : { refusal: `--probes ${path} cannot be read (ENOENT)` };

describe('what the --probes values say', () => {
  it('reads one file or none as before', () => {
    expect(readProbesFlags(['a.json'], read)).toEqual({ criteria: files['a.json'] });
    expect(readProbesFlags(['none'], read)).toEqual({ criteria: null });
  });

  it('reads a batch, each issue by its id with its criteria', () => {
    expect(readProbesFlags([`${A}=a.json`, `${B.toUpperCase()}=b.json`], read)).toEqual({
      batch: [
        { issue: A, criteria: files['a.json'] },
        { issue: B, criteria: files['b.json'] },
      ],
    });
  });

  it('refuses each wrong value by name, with the shape a batch takes', () => {
    const refusal = (values) => readProbesFlags(values, read).refusal;
    expect(refusal(['a.json', 'b.json'])).toMatch(/--probes a\.json names no issue; a batch names/);
    expect(refusal([`${A}=a.json`, 'none'])).toMatch(/--probes none names no issue/);
    expect(refusal(['ISS-12=a.json'])).toMatch(/ISS-12 is not an issue id/);
    expect(refusal([`${A}=a.json`, `${A}=b.json`])).toMatch(`names issue ${A} twice`);
    expect(refusal([`${A}=none`])).toMatch('an issue the batch lands has a criteria read');
    expect(refusal([`${A}=gone.json`])).toBe(
      `issue ${A}: --probes gone.json cannot be read (ENOENT)`,
    );
  });
});

describe("a batch's run and its report", () => {
  const spawn = () => ({ status: 0, stdout: '' });
  const carried = (sha) => sha === CARRIED;

  it("carries each issue's probes and standing under its id, and no top-level ones", async () => {
    const run = await runProbesRead(readProbesFlags([`${A}=a.json`, `${B}=b.json`], read), {
      root: '/',
      spawn,
      carried,
    });
    const ranA = run.checks.find((c) => c.scope === `issue ${A}, criterion 1`);
    expect(ranA?.result).toBe('pass');
    expect(run.checks.find((c) => c.scope === `issue ${B}`)?.result).toBe('none');
    const report = reportOf({
      branch: 'dev',
      baseSha: 'b'.repeat(40),
      head: 'a'.repeat(40),
      mode: 'pre-merge',
      touched: [],
      checks: run.checks,
      probes: run.bindings,
      standing: run.standing,
      issues: run.issues,
      patchId: '7'.repeat(40),
    });
    expect(report.issues).toEqual([
      { issue: A, probes: [{ criterion: 1, probe: 'pa', check: ranA?.id }] },
      { issue: B, probes: [], standing: [{ criterion: 2, verdict: 'vb' }] },
    ]);
    expect('probes' in report || 'standing' in report).toBe(false);
    expect(probeStandingLines(run, 'dev at bbbb')).toEqual([
      `issue ${B}: owes no probe, standing on a verdict dev at bbbb carries: criterion 2 (pass at cccccccccccc)`,
    ]);
  });

  it('names the issue of each probe missing or red', async () => {
    const red = await runProbesRead(readProbesFlags([`${A}=a.json`], read), {
      root: '/',
      spawn: () => ({ status: 1, stdout: '' }),
      carried,
    });
    expect(probeRefusalLines(red)).toEqual([
      `MERGE_PROBE_RED — issue ${A} criterion 1: it exited 1, expected 0`,
    ]);
  });

  it('reports one issue as before, its probes and standing at the top', async () => {
    const run = await runProbesRead(readProbesFlags(['b.json'], read), { root: '/', carried });
    const report = reportOf({
      branch: 'dev',
      baseSha: 'b'.repeat(40),
      head: 'a'.repeat(40),
      mode: 'pre-merge',
      touched: [],
      checks: run.checks,
      probes: run.bindings,
      standing: run.standing,
      issues: run.issues ?? null,
    });
    expect([report.probes, report.standing, 'issues' in report]).toEqual([
      [],
      [{ criterion: 2, verdict: 'vb' }],
      false,
    ]);
    expect(run.checks.map((c) => c.scope)).toEqual(['issue']);
  });
});
