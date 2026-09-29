import { describe, expect, it } from 'vitest';
import { checkReader } from './checks.mjs';

const SHA = 'a'.repeat(40);
const answering = (stdout, status = 0) => () => ({ status, stdout, stderr: 'no route' });
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
    for (const reply of ['not-json', '{}', 'null']) {
      expect(read(reply).refusal).toBe(
        `\`gh api repos/o/r/commits/${SHA}/check-runs?check_name=ci-passed\` answered \`${reply}\`, not a list of check runs, so ci-passed at ${SHA} is unknown`,
      );
    }
  });

  it('refuses when gh does not answer', () => {
    expect(read('', 1).refusal).toMatch(
      /did not answer \(no route\), so ci-passed at a+ is unknown$/,
    );
  });
});
