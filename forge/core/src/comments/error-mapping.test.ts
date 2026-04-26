import { describe, expect, it } from 'vitest';
import { pgConstraintName, pgErrorCode } from './error-mapping.js';

describe('pgErrorCode', () => {
  it('returns code from a flat postgres error', () => {
    expect(pgErrorCode({ code: '23514' })).toBe('23514');
  });

  it('walks one level of .cause (drizzle DrizzleQueryError shape)', () => {
    expect(pgErrorCode({ message: 'wrapped', cause: { code: '23503' } })).toBe('23503');
  });

  it('walks two levels of .cause (transaction helper double-wrap)', () => {
    expect(pgErrorCode({ cause: { cause: { code: '23505' } } })).toBe('23505');
  });

  it('returns undefined when no code present in chain', () => {
    expect(pgErrorCode({ message: 'plain' })).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode(undefined)).toBeUndefined();
  });

  it('terminates safely on cyclic cause chains', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(pgErrorCode(a)).toBeUndefined();
  });
});

describe('pgConstraintName', () => {
  it('reads constraint_name (postgres-js)', () => {
    expect(pgConstraintName({ constraint_name: 'comments_parent_id_fk' })).toBe(
      'comments_parent_id_fk',
    );
  });

  it('reads constraint (node-postgres)', () => {
    expect(pgConstraintName({ constraint: 'comments_issue_id_issues_id_fk' })).toBe(
      'comments_issue_id_issues_id_fk',
    );
  });

  it('walks the cause chain', () => {
    expect(
      pgConstraintName({
        cause: { cause: { constraint_name: 'comments_parent_id_fk' } },
      }),
    ).toBe('comments_parent_id_fk');
  });

  it('returns undefined when neither field is present', () => {
    expect(pgConstraintName({ code: '23503' })).toBeUndefined();
  });
});
