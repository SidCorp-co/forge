import { DrizzleQueryError } from 'drizzle-orm/errors';
import { stdSerializers } from 'pino';
import { describe, expect, it } from 'vitest';
import { isUniqueViolation, uniqueViolationConstraint, withoutQueryParams } from './db-errors.js';

describe('isUniqueViolation', () => {
  it('returns true for a top-level pg error with code 23505', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('returns true for a Drizzle-wrapped error whose cause has code 23505', () => {
    // drizzle-orm/postgres-js shape — the outer error has no `.code`; the
    // raw pg error lives on `.cause`. Without the cause-walk, this returns
    // false and callers fall through to a 500.
    const drizzleWrapped = Object.assign(new Error('Failed query: ...'), {
      query: '...',
      params: [],
      cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });
    expect(isUniqueViolation(drizzleWrapped)).toBe(true);
  });

  it('returns false for non-unique-violation pg codes', () => {
    expect(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
    expect(
      isUniqueViolation(
        Object.assign(new Error('outer'), {
          cause: Object.assign(new Error('inner'), { code: '23503' }),
        }),
      ),
    ).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(42)).toBe(false);
  });
});

describe('uniqueViolationConstraint', () => {
  it('reads constraint_name from a Drizzle-wrapped postgres-js error', () => {
    const err = Object.assign(new Error('Failed query: ...'), {
      cause: Object.assign(new Error('dup'), {
        code: '23505',
        constraint_name: 'projects_slug_unique',
      }),
    });
    expect(uniqueViolationConstraint(err)).toBe('projects_slug_unique');
  });

  it('reads constraint from a node-postgres-style top-level error', () => {
    const err = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'projects_slug_unique',
    });
    expect(uniqueViolationConstraint(err)).toBe('projects_slug_unique');
  });

  it('prefers cause.constraint_name over top-level constraint (Drizzle path is canonical)', () => {
    const err = Object.assign(new Error('outer'), {
      constraint: 'wrong',
      cause: Object.assign(new Error('inner'), { constraint_name: 'right' }),
    });
    expect(uniqueViolationConstraint(err)).toBe('right');
  });

  it('returns undefined when no constraint name is present', () => {
    expect(uniqueViolationConstraint(new Error('plain'))).toBeUndefined();
    expect(uniqueViolationConstraint(null)).toBeUndefined();
  });
});

describe('withoutQueryParams', () => {
  const HASH = '$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA';
  const failed = () =>
    new DrizzleQueryError(
      'insert into "users" ("email", "password_hash") values ($1, $2)',
      ['dup@example.test', HASH],
      Object.assign(new Error('duplicate key value'), { code: '23505' }),
    );

  it("redacts a failed query's params from what the log serializer makes of it", () => {
    const err = failed();
    const text = JSON.stringify(withoutQueryParams(stdSerializers.err(err), err));
    expect(text).not.toContain(HASH);
    expect(text).not.toContain('dup@example.test');
    expect(text).toContain('params: [Redacted]');
  });

  it('redacts them where the failed query is the cause of another error', () => {
    const err = new Error('register failed', { cause: failed() });
    const text = JSON.stringify(withoutQueryParams(stdSerializers.err(err), err));
    expect(text).not.toContain(HASH);
  });

  it('leaves what holds no failed query as it was', () => {
    const err = new Error('kaboom');
    expect(withoutQueryParams({ message: 'kaboom', params: [1] }, err)).toEqual({
      message: 'kaboom',
      params: [1],
    });
  });
});
