import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReader } from './checks.mjs';

const SHA = 'a'.repeat(40);
const answering =
  (stdout, status = 0) =>
  () => ({ status, stdout, stderr: 'no route' });
const read = (stdout, status) =>
  checkReader({ repoSlug: 'o/r', gh: answering(stdout, status) })(SHA, 'ci-passed');

describe('checkReader over gh api', () => {
  it('reads the newest run, its conclusion once completed and its status before', () => {
    const runs = [
      { started_at: '2026-09-29T01:00:00Z', status: 'completed', conclusion: 'failure' },
      {
        started_at: '2026-09-29T02:00:00Z',
        status: 'completed',
        conclusion: 'success',
        html_url: 'u',
      },
    ];
    expect(read(JSON.stringify(runs))).toEqual({ state: 'success', url: 'u' });
    expect(read(JSON.stringify([{ started_at: 'x', status: 'in_progress' }])).state).toBe(
      'in_progress',
    );
  });

  it('reads no run as absent, never as a pass', () => {
    expect(read('[]')).toEqual({ state: 'absent' });
  });

  it('refuses by name a reply that is not a list of runs', () => {
    const runs = (...r) => JSON.stringify(r);
    for (const reply of [
      'not-json',
      '{}',
      'null',
      runs(null),
      runs({}),
      runs({ started_at: null, status: 'queued' }),
      runs({ started_at: 'x', status: 'completed' }),
    ]) {
      expect(read(reply).refusal).toBe(
        `\`gh api repos/o/r/commits/${SHA}/check-runs?check_name=ci-passed\` answered \`${reply}\`, not a list of check runs each with its start, status and conclusion, so ci-passed at ${SHA} is unknown`,
      );
    }
  });

  it('refuses when gh does not answer', () => {
    expect(read('', 1).refusal).toMatch(
      /did not answer \(no route\), so ci-passed at a+ is unknown$/,
    );
  });
});

describe('checkReader over a saved checks file', () => {
  const fromFile = (doc) => {
    const dir = mkdtempSync(join(tmpdir(), 'checks-'));
    const file = join(dir, 'checks.json');
    writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
    const got = checkReader({ file })(SHA, 'ci-passed');
    rmSync(dir, { recursive: true, force: true });
    return { file, got };
  };

  it('reads a recorded conclusion, and a check it does not record as absent', () => {
    expect(fromFile({ [SHA]: { 'ci-passed': 'success' } }).got).toEqual({ state: 'success' });
    expect(fromFile({ [SHA]: { other: 'success' } }).got).toEqual({ state: 'absent' });
  });

  it('refuses a document of the wrong shape rather than reading it as absent', () => {
    const odd = `holds ${SHA} as something other than an object of check conclusions`;
    for (const [doc, why] of [
      [[], 'is not an object of commits'],
      [null, 'is not an object of commits'],
      [{ [SHA]: 'success' }, odd],
      [{ [SHA]: { 'ci-passed': true } }, odd],
    ]) {
      const { file, got } = fromFile(doc);
      expect(got.refusal).toBe(`the checks file ${file} ${why}`);
    }
  });
});
