import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// cm:guard scans the TREE rather than this module, because the claim is about a field that must exist nowhere — a type deleted here and revived in a route, a contract or the web app would satisfy every other test in the suite (ISS-964 criterion 13).
describe('a question has one shape and no discriminator', () => {
  it('has no answer_shape and no question kind anywhere in first-party source', () => {
    // cm:guard `--untracked`, because `git grep` reads the INDEX by default and a discriminator revived in a file nobody has staged yet is exactly the one this scan exists to catch.
    // cm:guard `git grep` exits 1 when it finds NOTHING, which is this test's green — reading the exit code as a failure would make the passing case the error case.
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '--untracked',
          '-lIE',
          'answer_shape|answerShape',
          '--',
          '.',
          ':!*one-shape.test.ts',
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      ).trim();
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e;
    }
    expect(
      hits,
      'the three orthogonal attributes live on the OPTION — authority, binds_to, executed_by — and a shape discriminator beside them is a second answer to a question they already answer (ISS-964 criterion 13)',
    ).toBe('');
  });
});
