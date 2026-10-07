import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

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
  const log = createLogger({ level: 'debug' }, { write: (s: string) => lines.push(s) });
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

  it('redacts a message the call names itself against the error it logs', () => {
    const pg = Object.assign(new Error('rejected input: abc'), {
      severity: 'ERROR',
      code: '22023',
    });
    Object.defineProperty(pg, 'parameters', { value: ['abc'], enumerable: false });
    const { lines, log } = capture();
    log.error({ err: pg }, pg.message);
    log.error({ err: pg }, 'failed with %s', pg.message);
    log.error({ err: pg, msg: pg.message });
    log.error({ err: pg, reason: pg.message, ctx: { detail: pg.message } }, 'failed');
    log.error({ err: pg }, 'failed %j', { reason: pg.message });
    for (const line of lines) expect(line).not.toContain('abc');
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0] ?? '').err.sqlstate).toBe('22023');
  });

  it('keeps a bound value that opens with the redaction marker out of an interpolated message', () => {
    const failed = new DrizzleQueryError(
      'select $1',
      [`${String.fromCharCode(0xe000)}SENTINEL`],
      new Error('x'),
    );
    const { lines, log } = capture();
    log.error(`lookup failed: ${failed.message}`);
    expect(lines[0]).not.toContain('SENTINEL');
  });

  it.each([
    [
      'beside the err it logs',
      (log: Logger, err: Error) => log.error({ err }, 'failed %j', { error: err }),
    ],
    ['with no err beside it', (log: Logger, err: Error) => log.error('failed %j', { error: err })],
    [
      'in context with no err beside it',
      (log: Logger, err: Error) => log.warn({ ctx: [err] }, 'failed'),
    ],
    [
      'spread into the context itself',
      (log: Logger, err: Error) => log.error({ ...err }, 'failed'),
    ],
    [
      'under another key, beside text repeating a bound value',
      (log: Logger, err: Error) =>
        log.error({ error: err, reason: `duplicate ${EMAIL}` }, 'failed'),
    ],
    [
      'interpolated after text repeating a bound value',
      (log: Logger, err: Error) => log.error(`duplicate ${EMAIL}: %j`, { error: err }),
    ],
    [
      'nine objects deep with no err beside it',
      (log: Logger, err: Error) => {
        let deep: object = { error: err };
        for (let i = 0; i < 9; i++) deep = { inner: deep };
        log.error(`duplicate ${EMAIL}: %j`, deep);
      },
    ],
  ])('serializes an error interpolated or carried %s without its bound values', (_, write) => {
    const { lines, log } = capture();
    write(log, failedInsert());
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    JSON.parse(line);
    expect(line).not.toContain(HASH);
    expect(line).not.toContain(EMAIL);
  });

  it('redacts the logged err against another error the same call carries', () => {
    const { lines, log } = capture();
    log.error({ err: new Error(`duplicate ${EMAIL}`), other: failedInsert() }, 'failed');
    log.error(new Error(`duplicate ${EMAIL}`), 'failed %j', { other: failedInsert() });
    for (const line of lines) {
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain(HASH);
    }
    const first = JSON.parse(lines[0] ?? '');
    expect(first.err.type).toBe('Error');
    expect(first.other.sqlstate).toBe('23505');
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

describe('the core logger, given what is not an Error', () => {
  it.each([
    ['a failed query', () => failedInsert().message],
    ['a value the database quotes', () => 'invalid input syntax for type uuid: "zq9"'],
  ])('reads an object under err again when it carries %s after a harmless line', (_, text) => {
    const { lines, log } = capture();
    const payload = { message: 'ordinary failure' };
    log.warn({ err: payload }, 'first');
    payload.message = text();
    log.warn({ err: payload }, 'second');
    log.child({ err: payload }).warn('third');
    expect(lines).toHaveLength(3);
    for (const line of lines.slice(1)) {
      expect(line).not.toContain(HASH);
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain('zq9');
    }
  });

  it.each([
    ['its message', (log: Logger, err: Error) => log.warn({ err: err.message, id: 'm1' }, 'g')],
    ['the message with no msg', (log: Logger, err: Error) => log.warn({ err: err.message })],
    ['String(err)', (log: Logger, err: Error) => log.warn({ err: String(err) }, 'h')],
    [
      'its message beside a status, as an HTTP error logs it',
      (log: Logger, err: Error) => log.warn({ status: 500, code: 'X', err: err.message }, 'e'),
    ],
    [
      'a plain object holding its message',
      (log: Logger, err: Error) => log.warn({ err: { message: err.message } }, 'p'),
    ],
    ['an array of its message', (log: Logger, err: Error) => log.warn({ err: [err.message] }, 'a')],
    [
      'a plain object holding the error itself',
      (log: Logger, err: Error) => log.warn({ err: { inner: err } }, 'o'),
    ],
    [
      'its message bound on a child',
      (log: Logger, err: Error) => log.child({ err: err.message }).warn('c'),
    ],
  ])("writes no failed query's bound params when err holds %s", (_, write) => {
    const { lines, log } = capture();
    write(log, failedInsert());
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    JSON.parse(line);
    expect(line).not.toContain(HASH);
    expect(line).not.toContain(EMAIL);
    expect(line).toContain('insert into');
  });

  it.each([
    ['a unique violation', `Key (email)=(${EMAIL}) already exists.`],
    ['a missing reference', `Key (owner_email)=(${EMAIL}) is not present in table "users".`],
    ['a not-null violation', `Failing row contains (7, ${EMAIL}, ${HASH}).`],
    ['a short value refused as a uuid', 'invalid input syntax for type uuid: "zq9"'],
    ['a short value refused by an enum', 'invalid input value for enum role: "zq9"'],
    ['a short value refused as an array', 'malformed array literal: "zq9"'],
    ['a value out of range', 'value "zq9999" is out of range for type integer'],
  ])("writes none of the values in %s's text copied into a field by hand", (_, text) => {
    const { lines, log } = capture();
    log.warn({ detail: text }, 'copied');
    log.warn({ err: text });
    log.warn(`refused: ${text}`);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain(HASH);
      expect(line).not.toContain('zq9');
    }
  });
});

/** A driver error as postgres-js throws it, its bound values non-enumerable as there. */
function refusal(message: string, fields: Record<string, unknown>, bound: unknown[]): Error {
  const pg = Object.assign(new Error(message), { severity: 'ERROR', ...fields });
  Object.defineProperty(pg, 'parameters', { value: bound, enumerable: false });
  return pg;
}

const DOCUMENT = '{"note":"zq9-secret-document"}';

function jsonRefusal(): DrizzleQueryError {
  const pg = refusal(
    'invalid input syntax for type json',
    {
      code: '22P02',
      detail: 'Token "zq9" is invalid.',
      where: `JSON data, line 1: ${DOCUMENT.slice(0, 20)}`,
    },
    [DOCUMENT],
  );
  return new DrizzleQueryError('insert into "notes" ("body") values ($1)', [DOCUMENT], pg);
}

describe('the core logger, given a driver error that quotes its input in its own fields', () => {
  it.each([
    ['under err', (log: Logger, err: DrizzleQueryError) => log.error({ err }, 'failed')],
    ['as the first argument', (log: Logger, err: DrizzleQueryError) => log.error(err)],
    [
      'its driver error under err',
      (log: Logger, err: DrizzleQueryError) => log.error({ err: err.cause }),
    ],
    [
      'under another key',
      (log: Logger, err: DrizzleQueryError) => log.error({ error: err.cause }, 'x'),
    ],
    [
      'bound on a child',
      (log: Logger, err: DrizzleQueryError) => log.child({ error: err }).error('x'),
    ],
  ])('writes none of the value it refused when the error is logged %s', (_, write) => {
    const { lines, log } = capture();
    write(log, jsonRefusal());
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('zq9');
    expect(lines[0]).toContain('22P02');
  });
});

describe("the core logger's child bindings", () => {
  it.each([
    ['a unique violation detail', `Key (email)=(${EMAIL}) already exists.`],
    ['a value refused as a uuid', 'invalid input syntax for type uuid: "zq9"'],
    ['a JSON refusal', `JSON data, line 1: ${DOCUMENT}`],
  ])('carry none of the value %s quotes, bound with no error beside it', (_, text) => {
    const { lines, log } = capture();
    log.child({ detail: text }).warn('bound');
    log.child({ requestId: 'r1' }).child({ reason: text }).warn('nested');
    log.child({}, { msgPrefix: `${text} ` }).warn('prefixed');
    const rebound = log.child({ requestId: 'r2' });
    rebound.setBindings({ reason: text });
    rebound.warn('rebound');
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain('zq9');
    }
  });

  it.each([
    ['bound on a child', (log: Logger, pg: Error) => log.child({ error: pg, reason: pg.message })],
    [
      'rebound with setBindings',
      (log: Logger, pg: Error) => {
        const rebound = log.child({ requestId: 'r1' });
        rebound.setBindings({ error: pg, reason: pg.message });
        return rebound;
      },
    ],
    [
      "prefixed to a child's every message",
      (log: Logger, pg: Error) => log.child({ error: pg }, { msgPrefix: `${pg.message}: ` }),
    ],
  ])('withhold a driver message %s beside the error that names its value', (_, make) => {
    const pg = refusal('relation "zq" does not exist', { code: '42P01' }, ['zq']);
    const { lines, log } = capture();
    make(log, pg).warn('bound');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '');
    expect(JSON.stringify([line.reason, line.msg])).not.toContain('zq');
    expect(line.error.sqlstate).toBe('42P01');
  });
});

describe('the core logger, at the finished line', () => {
  it('redacts what a value turns into only when the line is written', () => {
    const { lines, log } = capture();
    log.warn({ reading: { toJSON: () => 'invalid input syntax for type uuid: "zq9"' } }, 'read');
    log.warn({ reading: { toJSON: () => `Key (email)=(${EMAIL}) already exists.` } }, 'read');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('zq9');
      expect(line).not.toContain(EMAIL);
    }
  });
});

/** Each way a value's text reaches a line through what a serializer calls, not a field it holds. */
const SERIALIZER_HOOKS: [string, (text: string) => unknown][] = [
  ['its own toJSON', (text) => ({ toJSON: () => text })],
  ['a toJSON it inherits', (text) => Object.create({ toJSON: () => text })],
  [
    'a getter',
    (text) => Object.defineProperty({}, 'reason', { get: () => text, enumerable: true }) as unknown,
  ],
  [
    "a boxed string's Symbol.toPrimitive",
    (text) => Object.assign(new String('ordinary'), { [Symbol.toPrimitive]: () => text }),
  ],
  [
    "a boxed string's toString",
    (text) => Object.assign(new String('ordinary'), { toString: () => text }),
  ],
  ['a field of a tagged object', (text) => ({ [Symbol.toStringTag]: 'Reading', reason: text })],
];

/** A driver message only the error beside it can tell holds a bound value: no anchor names it. */
function relationRefusal(): Error {
  return refusal('relation "zq" does not exist', { code: '42P01' }, ['zq']);
}

describe('the core logger, given a value whose text only a serializer renders', () => {
  describe.each(SERIALIZER_HOOKS)('through %s', (_, hook) => {
    it.each([
      ['a failed query', () => failedInsert().message],
      ['a value the database quotes', () => 'invalid input syntax for type uuid: "zq9"'],
    ])('writes none of %s under err, with no error in the call', (_, text) => {
      const { lines, log } = capture();
      log.warn({ err: hook(text()) }, 'read');
      log.warn({ err: hook(text()) });
      log.child({ err: hook(text()) }).warn('bound');
      log.child({ requestId: 'r1' }).warn({ err: hook(text()) }, 'child');
      expect(lines).toHaveLength(4);
      for (const line of lines) {
        JSON.parse(line);
        expect(line).not.toContain(EMAIL);
        expect(line).not.toContain(HASH);
        expect(line).not.toContain('zq9');
      }
    });

    it.each([
      ['err', 'err'],
      ['a plain key', 'reading'],
    ])('withholds a driver message under %s, read against the error beside it', (_, key) => {
      const { lines, log } = capture();
      const pg = relationRefusal();
      log.warn({ error: pg, [key]: hook(pg.message) }, 'read');
      log.child({ error: pg, [key]: hook(pg.message) }).warn('bound');
      log.child({ requestId: 'r1' }).warn({ error: pg, [key]: hook(pg.message) }, 'child');
      const rebound = log.child({ requestId: 'r2' });
      rebound.setBindings({ error: pg, [key]: hook(pg.message) });
      rebound.warn('rebound');
      expect(lines).toHaveLength(4);
      for (const line of lines) {
        expect(JSON.parse(line).error.sqlstate).toBe('42P01');
        expect(line).not.toContain('zq');
      }
    });
  });

  it.each([
    ['its toString', (text: string) => ({ toString: () => text })],
    ['its Symbol.toPrimitive', (text: string) => ({ [Symbol.toPrimitive]: () => text })],
  ])('writes none of a driver message a format argument renders through %s', (_, hook) => {
    const { lines, log } = capture();
    const pg = relationRefusal();
    log.warn({ error: pg }, 'read %s', hook(pg.message));
    log.child({ requestId: 'r1' }).warn({ error: pg }, 'child %s', hook(pg.message));
    log.warn(
      { err: hook('invalid input syntax for type uuid: "zq9"') as never },
      'blind %s',
      hook('invalid input syntax for type uuid: "zq9"'),
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain('zq');
      expect(line).not.toContain('[object Object]');
    }
  });

  it.each([
    ['its toString', (text: string) => ({ toString: () => text })],
    ['its Symbol.toPrimitive', (text: string) => ({ [Symbol.toPrimitive]: () => text })],
  ])(
    "writes none of a driver message a child's msgPrefix joins to a message rendered by %s",
    (_, hook) => {
      const { lines, log } = capture();
      const pg = relationRefusal();
      const prefixed = log.child({}, { msgPrefix: 'read: ' });
      prefixed.warn({ error: pg }, hook(pg.message) as never);
      prefixed.child({ requestId: 'r1' }).warn({ error: pg }, hook(pg.message) as never);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).not.toContain('zq');
    },
  );

  it('keeps what a format argument renders when it carries nothing to redact', () => {
    const { lines, log } = capture();
    log.warn('read %s and %s', { toString: () => 'a reading' }, new URL('https://example.test/x'));
    expect(JSON.parse(lines[0] ?? '').msg).toBe('read a reading and https://example.test/x');
  });
});
