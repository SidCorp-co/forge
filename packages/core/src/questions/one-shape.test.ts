import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SCHEMA = 'src/db/schema-questions.ts';

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

  it('has no option kind anywhere in first-party source', () => {
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
