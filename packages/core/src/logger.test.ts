import { DrizzleQueryError } from 'drizzle-orm/errors';
import { type Logger, pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$bG9nZ2VyLWhhc2g';
const EMAIL = 'dup@example.test';

function failedInsert(): DrizzleQueryError {
  const driver = Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_unique"'),
    {
      severity: 'ERROR',
      code: '23505',
      constraint_name: 'users_email_unique',
      detail: `Key (email)=(${EMAIL}) already exists.`,
    },
  );
  return new DrizzleQueryError(
    'insert into "users" ("email", "password_hash") values ($1, $2)',
    [EMAIL, HASH],
    driver,
  );
}

function capture(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  const log = pino({ ...loggerOptions, level: 'debug' }, { write: (s: string) => lines.push(s) });
  return { lines, log };
}

describe('the core logger', () => {
  it.each([
    ['under err, with a message', (log: Logger, err: Error) => log.error({ err }, 'boom')],
    ['under err, with none', (log: Logger, err: Error) => log.error({ err })],
    ['as the first argument', (log: Logger, err: Error) => log.error(err)],
    ['under another key', (log: Logger, err: Error) => log.error({ error: err }, 'boom')],
    ['interpolated into the text', (log: Logger, err: Error) => log.error(`x: ${err.message}`)],
    [
      'from a child, as a request logs it',
      (log: Logger, err: Error) => log.child({ requestId: 'r1' }).error({ err }),
    ],
  ])("writes no failed query's bound params when the error is logged %s", (_, write) => {
    const { lines, log } = capture();
    write(log, failedInsert());
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain(HASH);
    expect(line).not.toContain(EMAIL);
    expect(line).toContain('[Redacted]');
    expect(line.endsWith('\n')).toBe(true);
    JSON.parse(line);
  });

  it("withholds a driver error's own message when it repeats a bound value and names no msg", () => {
    const pg = Object.assign(new Error('invalid input syntax for type uuid: "abc"'), {
      severity: 'ERROR',
      code: '22P02',
    });
    Object.defineProperty(pg, 'parameters', { value: ['abc'], enumerable: false });
    const { lines, log } = capture();
    log.error(pg);
    log.error({ err: pg });
    for (const line of lines) expect(line).not.toContain('abc');
    expect(JSON.parse(lines[0] ?? '').err.sqlstate).toBe('22P02');
  });

  it('still names the statement, the SQLSTATE and the constraint', () => {
    const { lines, log } = capture();
    log.error({ err: failedInsert() }, 'http.unhandled');
    const line = JSON.parse(lines[0] ?? '');
    expect(line.err.query).toContain('insert into "users"');
    expect(line.err.message).toContain('violates unique constraint "users_email_unique"');
    expect(line.err.sqlstate).toBe('23505');
    expect(line.err.constraint).toBe('users_email_unique');
    expect(line.msg).toBe('http.unhandled');
  });

  it('leaves a line that carries no failed query exactly as pino wrote it', () => {
    const { lines, log } = capture();
    log.info({ params: { id: 7 } }, 'route params');
    expect(JSON.parse(lines[0] ?? '').params).toEqual({ id: 7 });
  });
});
