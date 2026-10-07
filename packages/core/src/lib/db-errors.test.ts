import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import {
  isUniqueViolation,
  pgBoundValues,
  pgConstraintName,
  pgDriverError,
  pgErrorClassDescription,
  pgErrorCode,
  pgObjectNames,
} from './db-errors.js';

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

  it('reads the code through the error drizzle itself throws, and through one more wrapper', () => {
    const driver = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: 'users_email_unique',
    });
    const failed = new DrizzleQueryError('insert into "users" values ($1)', ['a@b.co'], driver);
    expect(isUniqueViolation(failed)).toBe(true);
    expect(isUniqueViolation(new Error('register failed', { cause: failed }))).toBe(true);
    expect(pgConstraintName(new Error('register failed', { cause: failed }))).toBe(
      'users_email_unique',
    );
  });

  it('stops at a cycle and at the depth bound rather than looping', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
    let deep: unknown = Object.assign(new Error('pg'), { code: '23505' });
    for (let i = 0; i < 8; i++) deep = new Error(`wrap ${i}`, { cause: deep });
    expect(isUniqueViolation(deep)).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(42)).toBe(false);
  });
});

describe('pgConstraintName', () => {
  it('reads constraint_name from a Drizzle-wrapped postgres-js error', () => {
    const err = Object.assign(new Error('Failed query: ...'), {
      cause: Object.assign(new Error('dup'), {
        code: '23505',
        constraint_name: 'projects_slug_unique',
      }),
    });
    expect(pgConstraintName(err)).toBe('projects_slug_unique');
  });

  it('reads constraint from a node-postgres-style top-level error', () => {
    const err = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'projects_slug_unique',
    });
    expect(pgConstraintName(err)).toBe('projects_slug_unique');
  });

  it('prefers cause.constraint_name over top-level constraint (Drizzle path is canonical)', () => {
    const err = Object.assign(new Error('outer'), {
      constraint: 'wrong',
      cause: Object.assign(new Error('inner'), { constraint_name: 'right' }),
    });
    expect(pgConstraintName(err)).toBe('right');
  });

  it('returns undefined when no constraint name is present', () => {
    expect(pgConstraintName(new Error('plain'))).toBeUndefined();
    expect(pgConstraintName(null)).toBeUndefined();
  });
});

describe('pgErrorCode', () => {
  it('skips a code that is not a SQLSTATE to reach the driver one beneath it', () => {
    const err = Object.assign(new Error('outer'), {
      code: 'CONNECTION_CLOSED',
      cause: Object.assign(new Error('inner'), { code: '40P01' }),
    });
    expect(pgErrorCode(err)).toBe('40P01');
  });

  it('returns undefined where nothing on the chain is a SQLSTATE', () => {
    expect(pgErrorCode(Object.assign(new Error('fs'), { code: 'ENOENT' }))).toBeUndefined();
  });
});

describe('pgDriverError', () => {
  it('reads the driver error under drizzle’s wrapper, never the wrapper', () => {
    const wrapped = new DrizzleQueryError(
      'update "issues" set "status" = $1',
      ['closed'],
      Object.assign(new Error('row refused'), { code: 'P0001' }),
    );
    expect(pgDriverError(wrapped)).toEqual({ code: 'P0001', message: 'row refused' });
  });

  it('finds nothing on an error that carries no SQLSTATE', () => {
    expect(pgDriverError(Object.assign(new Error('gone'), { code: 'ECONNRESET' }))).toBeUndefined();
    expect(pgDriverError('plain')).toBeUndefined();
  });
});

describe('pgErrorClassDescription', () => {
  it('names a class by its first two characters, and a class it does not know generically', () => {
    expect(pgErrorClassDescription('22P02')).toBe('a value it was given was invalid');
    expect(pgErrorClassDescription('P0001')).toBe('a database function or trigger raised an error');
    expect(pgErrorClassDescription('XX000')).toBe('the database refused the statement');
  });
});

describe('pgBoundValues', () => {
  it('reads every non-empty value a failed statement was bound with', () => {
    const wrapped = new DrizzleQueryError(
      'update x set a = $1, b = $2, c = $3',
      ['abc', '', 7],
      new Error('x'),
    );
    expect(pgBoundValues(wrapped)).toEqual(['abc', '7']);
    expect(pgBoundValues(new Error('plain'))).toEqual([]);
  });
});

describe('pgObjectNames', () => {
  it('reads every schema object name off the driver error, longest first, and none off a wrapper', () => {
    const driver = Object.assign(new Error('violates check constraint'), {
      code: '23514',
      constraint_name: 'gj_closed_needs_ledger',
      table_name: 'issues',
      schema_name: 'public',
    });
    const wrapped = Object.assign(new Error('Failed query', { cause: driver }), {
      table: 'not-a-driver-field',
    });

    expect(pgObjectNames(wrapped).map((o) => [o.words[0], o.name])).toEqual([
      ['constraint', 'gj_closed_needs_ledger'],
      ['relation', 'issues'],
      ['schema', 'public'],
    ]);
  });

  it('reads node-postgres spellings, and nothing where the driver named no object', () => {
    const named = Object.assign(new Error('x'), { code: '23503', constraint: 'fk_a', table: 't' });
    expect(pgObjectNames(named).map((o) => o.name)).toEqual(['fk_a', 't']);
    expect(pgObjectNames(Object.assign(new Error('raised'), { code: 'P0001' }))).toEqual([]);
  });
});
