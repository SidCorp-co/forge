import { REDACTED, redactedMessage, redactQueryParams, sealQueryError } from '@forge/observability';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { PgPreparedQuery } from 'drizzle-orm/pg-core';
import { PostgresJsSession, PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { stdSerializers } from 'pino';
import { describe, expect, it } from 'vitest';
import { installQueryErrorSeal } from './query-error-seal.js';

/** A driver error as postgres-js throws it: its bound values ride non-enumerable, as there. */
function pgRefusal(message: string, fields: Record<string, unknown>, bound: unknown[]): Error {
  const pg = Object.assign(new Error(message), { severity: 'ERROR', ...fields });
  Object.defineProperty(pg, 'parameters', { value: bound, enumerable: false });
  return pg;
}

const DOCUMENT = '{"note":"zq9-secret-document"}';

/** What `COMMIT` rejects with for a deferred unique violation: a driver error and no wrapper. */
function commitRefusal(): Error {
  return pgRefusal(
    'duplicate key value violates unique constraint "notes_body_key"',
    {
      code: '23505',
      detail: 'Key (body)=(zq9-secret-document) already exists.',
      constraint_name: 'notes_body_key',
    },
    [],
  );
}

function jsonRefusal(): Error {
  return pgRefusal(
    'invalid input syntax for type json',
    {
      code: '22P02',
      detail: 'Token "zq9" is invalid.',
      where: `JSON data, line 1: ${DOCUMENT.slice(0, 20)}...`,
      hint: 'Check zq9-secret-document',
      constraint_name: 'notes_body_check',
    },
    [DOCUMENT],
  );
}

describe('sealQueryError', () => {
  function sealed(): DrizzleQueryError {
    return sealQueryError(new DrizzleQueryError('select $1::jsonb', [DOCUMENT], jsonRefusal()));
  }

  it('leaves no bound value in the message, the stack or anything the error serializes as', () => {
    const err = sealed();
    expect(err.message).toBe(`Failed query: select $1::jsonb\nparams: ${REDACTED}`);
    expect(err.stack).not.toContain('zq9');
    expect(String(err)).not.toContain('zq9');
    expect(JSON.stringify(err)).not.toContain('zq9');
    expect(JSON.stringify(stdSerializers.err(err))).not.toContain('zq9');
    const cause = err.cause as Error & Record<string, unknown>;
    expect(`${cause.message} ${cause.stack} ${JSON.stringify(cause)}`).not.toContain('zq9');
  });

  it('keeps the statement, the SQLSTATE, the constraint and the values for a later redaction', () => {
    const err = sealed();
    const cause = err.cause as unknown as Record<string, unknown>;
    expect(err.query).toBe('select $1::jsonb');
    expect(cause.code).toBe('22P02');
    expect(cause.constraint_name).toBe('notes_body_check');
    expect(cause.message).toBe('invalid input syntax for type json');
    expect(redactQueryParams({ copied: `seen ${DOCUMENT}` }, err).copied).toBe(`seen ${REDACTED}`);
  });

  it("drops a value the driver's message quotes and keeps the reason around it", () => {
    const err = sealQueryError(
      new DrizzleQueryError(
        'select $1::regclass',
        ['zq9'],
        pgRefusal('relation "zq9" does not exist', { code: '42P01' }, ['zq9']),
      ),
    );
    expect((err.cause as Error).message).toBe(`relation ${REDACTED} does not exist`);
  });

  it('keeps its reason and its frames when a sink redacts it again', () => {
    const err = sealed();
    const logged = redactQueryParams(stdSerializers.err(err), err);
    expect(logged.message).toBe(
      `Failed query: select $1::jsonb\nparams: ${REDACTED}: invalid input syntax for type json`,
    );
    expect(logged.stack).toContain(`params: ${REDACTED}\n    at `);
    expect(redactQueryParams(`lookup failed: ${err.message}`, err)).toBe(
      `lookup failed: ${err.message}`,
    );
  });

  it('hands back what is not a failed query untouched', () => {
    const plain = new Error('nothing to seal');
    expect(sealQueryError(plain)).toBe(plain);
    expect(plain.message).toBe('nothing to seal');
  });

  it('withholds a driver message that still holds a short bound value nothing quotes', () => {
    const err = sealQueryError(
      new DrizzleQueryError(
        'select $1',
        ['abc'],
        pgRefusal('rejected input: abc', { code: '22023' }, ['abc']),
      ),
    );
    const cause = err.cause as Error;
    expect(cause.message).toBe(REDACTED);
    expect(`${cause.stack}`).not.toContain('abc');
  });

  it('keeps a sealed message whole beside a shorter one that a token of its own could hold', () => {
    const err = sealQueryError(
      new DrizzleQueryError('select $1', ['x'], pgRefusal('0', { code: 'P0001' }, [])),
    );
    expect(redactedMessage(err)).toBe(err.message);
    const stack = redactQueryParams(stdSerializers.err(err), err).stack;
    expect(stack).toContain('select $1');
    expect(stack).toContain('    at ');
    expect(stack).not.toMatch(/[\ue000-\ue001]/);
  });

  it('holds no sealed message whole where it sits inside a bound value a sink still has to find', () => {
    const err = sealQueryError(
      new DrizzleQueryError('select $1', ['secret0value'], pgRefusal('0', { code: 'P0001' }, [])),
    );
    expect(redactQueryParams({ copied: 'secret0value' }, err).copied).toBe(REDACTED);
    expect(redactedMessage(err)).toBe(err.message);
  });

  it('reads no redaction it made as a value, however often a transaction seals it', () => {
    const err = new DrizzleQueryError(
      'select $1::uuid',
      ['Redact'],
      pgRefusal('invalid input syntax for type uuid: "Redact"', { code: '22P02' }, ['Redact']),
    );
    sealQueryError(sealQueryError(err));
    expect((err.cause as Error).message).toBe(`invalid input syntax for type uuid: ${REDACTED}`);
    expect(redactedMessage(err.cause)).toBe(`invalid input syntax for type uuid: ${REDACTED}`);
    const logged = redactQueryParams(stdSerializers.err(err), err);
    expect(logged.message).toContain(`: invalid input syntax for type uuid: ${REDACTED}`);
    expect(logged.stack).toContain('    at ');
    expect(err.message).toBe(`Failed query: select $1::uuid\nparams: ${REDACTED}`);
  });

  it('seals a driver error a transaction rejects by itself, with no drizzle error around it', () => {
    const pg = pgRefusal(
      'duplicate key value violates unique constraint "notes_body_key"',
      {
        code: '23505',
        detail: 'Key (body)=(zq9-secret-document) already exists.',
        constraint_name: 'notes_body_key',
      },
      [],
    );
    expect(sealQueryError(pg)).toBe(pg);
    expect(JSON.stringify(pg)).not.toContain('zq9');
    expect(pg.message).toBe('duplicate key value violates unique constraint "notes_body_key"');
  });
});

describe('sealQueryError, given fields the driver defined for good', () => {
  it("empties a field the driver fixed for good, and the database's failure stands", () => {
    const value = 'zq9-debug-bound-value';
    const pg = Object.assign(new Error(`invalid input syntax for type uuid: "${value}"`), {
      severity: 'ERROR',
      code: '22P02',
    });
    Object.defineProperties(pg, {
      query: { value: 'select $1::uuid', enumerable: true },
      parameters: { value: [value], enumerable: true },
      args: { value: [value], enumerable: true },
    });
    expect(sealQueryError(pg)).toBe(pg);
    expect(pg.message).toBe(`invalid input syntax for type uuid: ${REDACTED}`);
    expect((pg as unknown as Record<string, unknown>).code).toBe('22P02');
    expect(JSON.stringify(pg)).not.toContain('zq9');
    expect(redactQueryParams({ copied: `saw ${value}` }, pg).copied).toBe(`saw ${REDACTED}`);
  });

  it.each([
    ['by itself', (pg: Error) => sealQueryError(pg)],
    [
      'as the cause of a failed query',
      (pg: Error) => sealQueryError(new DrizzleQueryError('select $1', ['zq9-secret'], pg)),
    ],
  ])('copies a driver error that fixed its input in a field for good, %s', (_, seal) => {
    const pg = pgRefusal('refused', { code: '23514', constraint_name: 'notes_check' }, []);
    Object.defineProperty(pg, 'detail', { value: 'zq9-secret', enumerable: true });
    const sealed = seal(pg);
    expect(JSON.stringify(sealed)).not.toContain('zq9');
    const driver = (sealed instanceof DrizzleQueryError ? sealed.cause : sealed) as Error &
      Record<string, unknown>;
    expect(driver).not.toBe(pg);
    expect(driver.code).toBe('23514');
    expect(driver.constraint_name).toBe('notes_check');
    expect(driver.message).toBe('refused');
  });

  it('rewrites in place a field the driver made permanent but left writable', () => {
    const pg = pgRefusal('refused', { code: '23514', constraint_name: 'notes_check' }, []);
    Object.defineProperty(pg, 'detail', {
      value: 'zq9-secret',
      writable: true,
      configurable: false,
      enumerable: true,
    });
    expect(sealQueryError(pg)).toBe(pg);
    expect(JSON.stringify(pg)).not.toContain('zq9');
    expect((pg as unknown as Record<string, unknown>).code).toBe('23514');
  });

  it('copies every link above a copied driver error that cannot take the copy as its cause', () => {
    const pg = pgRefusal('refused', { code: '23514', constraint_name: 'notes_check' }, []);
    Object.defineProperty(pg, 'detail', { value: 'zq9-secret', enumerable: true });
    const failed = new DrizzleQueryError('select $1', ['zq9-secret'], new Error('placeholder'));
    delete (failed as { cause?: unknown }).cause;
    Object.defineProperty(failed, 'cause', { value: pg, enumerable: true });
    const sealed = sealQueryError(failed);
    expect(sealed).not.toBe(failed);
    expect(sealed).toBeInstanceOf(DrizzleQueryError);
    expect(JSON.stringify(sealed)).not.toContain('zq9');
    expect(`${sealed.message} ${sealed.stack}`).not.toContain('zq9');
    expect((sealed.cause as unknown as Record<string, unknown>).code).toBe('23514');
  });

  it('copies a driver error whose fixed array of bound values is frozen as well', () => {
    const pg = Object.assign(new Error('duplicate key'), {
      severity: 'ERROR',
      code: '23505',
      constraint_name: 'notes_key',
    });
    Object.defineProperty(pg, 'parameters', {
      value: Object.freeze(['zq9-secret']),
      enumerable: true,
    });
    const sealed = sealQueryError(pg) as Error & Record<string, unknown>;
    expect(JSON.stringify(sealed)).not.toContain('zq9');
    expect(sealed.code).toBe('23505');
    expect(sealed.constraint_name).toBe('notes_key');
  });
});

describe('installQueryErrorSeal', () => {
  it("seals what drizzle's own queryWithCache throws for a statement the driver refused", async () => {
    installQueryErrorSeal();
    const prepared = PgPreparedQuery.prototype as unknown as {
      queryWithCache(q: string, p: unknown[], run: () => Promise<unknown>): Promise<unknown>;
    };
    const err = await prepared.queryWithCache
      .call({}, 'select $1::jsonb', [DOCUMENT], () => Promise.reject(jsonRefusal()))
      .then(
        () => expect.unreachable('the refusal was swallowed'),
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(DrizzleQueryError);
    expect(`${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain('zq9');
  });

  it.each([
    [
      'a transaction',
      PostgresJsSession.prototype,
      { client: { begin: () => Promise.reject(commitRefusal()) } },
    ],
    [
      'a nested transaction',
      PostgresJsTransaction.prototype,
      { session: { client: { savepoint: () => Promise.reject(commitRefusal()) } } },
    ],
  ])('seals what the driver itself rejects %s with', async (_, proto, self) => {
    installQueryErrorSeal();
    const door = proto as unknown as { transaction(this: unknown, run: unknown): Promise<unknown> };
    const err = await door.transaction
      .call(self, async () => undefined)
      .then(
        () => expect.unreachable('the rejection was swallowed'),
        (e: unknown) => e as Error,
      );
    expect(JSON.stringify(err)).not.toContain('zq9');
    expect((err as unknown as Record<string, unknown>).constraint_name).toBe('notes_body_key');
  });

  it('wraps each door once however often it is installed', () => {
    const door = { run: async () => 1 };
    installQueryErrorSeal([[door, 'run']]);
    const once = door.run;
    installQueryErrorSeal([[door, 'run']]);
    expect(door.run).toBe(once);
  });

  it('refuses by name a drizzle that no longer has a door, rather than running unsealed', () => {
    expect(() => installQueryErrorSeal([[{}, 'queryWithCache']])).toThrow(
      /no queryWithCache on Object/,
    );
  });
});
