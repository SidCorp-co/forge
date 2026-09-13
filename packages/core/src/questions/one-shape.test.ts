// What this defends is a claim about the OPTION: what an option does is three
// orthogonal facts carried on it — who may choose it, how far the choice
// reaches, who carries it out — and a `kind` beside them is a second answer to
// a question those three already answer (ISS-964 criterion 13).
//
// It was a tree-wide grep for `answerShape` until ISS-996 gave the STEP a shape
// tag, which answers a different question — what an answer to this round looks
// like — and a grep on the name could not tell the two apart. So the option's
// own field list is read instead, which also catches a `kind` the grep never
// named.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SCHEMA = 'src/db/schema-questions.ts';

// cm:guard the option's fields are asserted as a SET and the assertion is the whole list, not a ban list: a discriminator arrives under whatever name its author picks, and a check that names the forbidden ones catches only the names somebody already thought of (ISS-964 criterion 13).
const OPTION_FIELDS = ['id', 'label', 'authority', 'bindsTo', 'executedBy', 'fingerprint'] as const;

function fieldsOf(type: string): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const start = src.indexOf(`export type ${type} = {`);
  if (start < 0) throw new Error(`${SCHEMA} declares no ${type}`);
  const body = src.slice(start, src.indexOf('\n};', start));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] as string);
}

describe('an option has one shape and no discriminator', () => {
  it('carries exactly the three orthogonal facts, its id and its label', () => {
    expect(
      fieldsOf('QuestionOption').sort(),
      'a field on the option beyond these is a second answer to what authority, bindsTo and executedBy already answer (ISS-964 criterion 13)',
    ).toEqual([...OPTION_FIELDS].sort());
  });

  // cm:guard scans the TREE rather than this module, because the claim is about a name that must exist nowhere — a discriminator deleted here and revived in a route, a contract or the web app would satisfy every other test in the suite (ISS-964 criterion 13).
  it('has no option kind anywhere in first-party source', () => {
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
          'option_kind|optionKind|permission_kind|permissionKind',
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
      'the three orthogonal attributes live on the OPTION, and a kind beside them is a second answer to a question they already answer (ISS-964 criterion 13)',
    ).toBe('');
  });
});
