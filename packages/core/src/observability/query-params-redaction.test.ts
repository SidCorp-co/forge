import { REDACTED, redactQueryParams } from '@forge/observability';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { stdSerializers } from 'pino';
import { describe, expect, it } from 'vitest';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$c3ludGhldGljLWhhc2g';
const EMAIL = 'dup@example.test';
const STATEMENT = 'insert into "users" ("email", "password_hash") values ($1, $2)';

function driverError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { severity: 'ERROR', ...extra });
}

function duplicate(): DrizzleQueryError {
  return new DrizzleQueryError(
    STATEMENT,
    [EMAIL, HASH],
    driverError('duplicate key value violates unique constraint "users_email_unique"', {
      code: '23505',
      constraint_name: 'users_email_unique',
      detail: `Key (email)=(${EMAIL}) already exists.`,
    }),
  );
}

describe('redactQueryParams', () => {
  it('keeps the statement and the driver reason, and none of the bound values', () => {
    const err = duplicate();
    const out = redactQueryParams(stdSerializers.err(err), err);
    expect(JSON.stringify(out)).not.toContain(HASH);
    expect(JSON.stringify(out)).not.toContain(EMAIL);
    expect(out.message).toBe(
      `Failed query: ${STATEMENT}\nparams: ${REDACTED}: duplicate key value violates unique constraint "users_email_unique"`,
    );
    expect(out.stack).toContain(`params: ${REDACTED}\n    at `);
  });

  it('redacts a failed query named by its text alone, to the end of the text', () => {
    const err = duplicate();
    const out = redactQueryParams(`register failed: ${err.message}`);
    expect(out).toBe(`register failed: Failed query: ${STATEMENT}\nparams: ${REDACTED}`);
  });

  it('trusts no stack-frame-shaped text inside a value as where the values end', () => {
    const forged = 'x\n    at synthetic (input.js:1:1)\nSENTINEL-after-frame';
    const err = new DrizzleQueryError(
      'select $1',
      [forged],
      driverError('boom', { code: 'XX000' }),
    );
    expect(redactQueryParams(err.message)).not.toContain('SENTINEL');
    expect(redactQueryParams(err.stack, err)).not.toContain('SENTINEL');
  });

  it('withholds a driver message that repeats a bound value, however short', () => {
    const err = new DrizzleQueryError(
      'select $1::uuid',
      ['abc'],
      driverError('invalid input syntax for type uuid: abc', { code: '22P02' }),
    );
    const wrapped = new Error('lookup failed', { cause: err });
    const text = JSON.stringify(redactQueryParams(stdSerializers.err(wrapped), wrapped));
    expect(text).not.toMatch(/uuid: abc/);
    expect(text).toContain('select $1::uuid');
  });

  it("redacts a driver error's detail and its own bound parameters when it is logged by itself", () => {
    const pg = driverError('duplicate key value', {
      code: '23505',
      detail: `Key (email)=(${EMAIL}) already exists.`,
    });
    Object.defineProperty(pg, 'parameters', { value: [EMAIL], enumerable: false });
    expect(JSON.stringify(redactQueryParams(stdSerializers.err(pg), pg))).not.toContain(EMAIL);
    expect(JSON.stringify(redactQueryParams({ ...stdSerializers.err(pg) }))).not.toContain(EMAIL);
  });

  it('redacts the params of any object that also names its query, with no error to read', () => {
    const line = { level: 50, error: { query: STATEMENT, params: [EMAIL, HASH] } };
    expect(JSON.stringify(redactQueryParams(line))).not.toMatch(/argon2|dup@example/);
  });

  it('takes no bound value that opens with the redaction marker for a redaction already made', () => {
    const forged = `${String.fromCharCode(0xe000)}SENTINEL`;
    const err = new DrizzleQueryError('select $1', [forged], driverError('x', { code: 'XX000' }));
    expect(redactQueryParams(err.message)).not.toContain('SENTINEL');
    expect(redactQueryParams(err.message, err)).not.toContain('SENTINEL');
  });

  it('lets no shorter bound value hold part of a longer one in place', () => {
    const inner = new DrizzleQueryError(
      'select $1',
      ['abcdefSECRET'],
      driverError('x', { code: 'XX000' }),
    );
    const outer = new DrizzleQueryError('select $1', ['abc'], inner);
    expect(redactQueryParams(inner.message, outer)).toBe(
      `Failed query: select $1\nparams: ${REDACTED}`,
    );
  });

  it('lets no rendering found inside a driver message hold part of it in place', () => {
    const driver = driverError('invalid input: "params: abcSECRET"', { code: '22P02' });
    const inner = new DrizzleQueryError('select $1', ['params: abcSECRET'], driver);
    const outer = new DrizzleQueryError('select $1', ['abc'], inner);
    expect(redactQueryParams(driver.message, outer)).toBe(REDACTED);
  });

  it('hands back the same value where there is nothing to redact', () => {
    const event = { exception: { values: [{ value: 'kaboom', params: [1] }] } };
    expect(redactQueryParams(event)).toBe(event);
    expect(redactQueryParams('route params: id')).toBe('route params: id');
  });
});
