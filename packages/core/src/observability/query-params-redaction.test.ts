import { REDACTED, redactedMessage, redactQueryParams } from '@forge/observability';
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

  it('walks an Error left in a payload as what it would serialize as', () => {
    const body = { code: 'CONFLICT', details: { error: duplicate() } };
    const text = JSON.stringify(redactQueryParams(body));
    expect(text).not.toContain(HASH);
    expect(text).not.toContain(EMAIL);
    expect(text).toContain('insert into');
  });

  it('withholds a subtree deeper than it reads rather than passing it through', () => {
    let deep: unknown = { error: duplicate() };
    for (let i = 0; i < 17; i++) deep = { inner: deep };
    expect(JSON.stringify(redactQueryParams(deep))).not.toContain(HASH);
    for (let i = 0; i < 40; i++) deep = { inner: deep };
    const text = JSON.stringify(redactQueryParams(deep));
    expect(text).not.toContain(HASH);
    expect(text).toContain(REDACTED);
  });

  it.each([
    [`Key (email)=(${EMAIL}) already exists.`, `Key (email)=(${REDACTED}`],
    [`Key (a, b)=(1, ${EMAIL}) is still referenced from table "t".`, `Key (a, b)=(${REDACTED}`],
    [`Failing row contains (7, ${EMAIL}, null).`, `Failing row contains (${REDACTED}`],
    [
      'invalid input syntax for type uuid: "zq9"',
      `invalid input syntax for type uuid: ${REDACTED}`,
    ],
    ['invalid input value for enum role: "zq9"', `invalid input value for enum role: ${REDACTED}`],
    ['malformed record literal: "zq9"', `malformed record literal: ${REDACTED}`],
    [
      'date/time field value out of range: "zq9"',
      `date/time field value out of range: ${REDACTED}`,
    ],
    ['value "99999999999" is out of range for type integer', `value ${REDACTED}`],
    ['invalid value "zq9f" for "YYYY"', `invalid value ${REDACTED}`],
  ])("redacts a value the database's own text quotes, with no error to read: %s", (text, kept) => {
    const out = redactQueryParams({ reason: `refused: ${text}` });
    expect(out.reason).toBe(`refused: ${kept}`);
  });

  it('redacts a quoted value to the end of the text, trusting no quote inside it', () => {
    const out = redactQueryParams('invalid input syntax for type uuid: "a" b\nSENTINEL"');
    expect(out).not.toContain('SENTINEL');
  });

  it('keeps the reason a constraint names, which quotes no value', () => {
    const text = 'duplicate key value violates unique constraint "users_email_unique"';
    expect(redactQueryParams(text)).toBe(text);
  });

  it("redacts an error's message against the error itself, as a bare string no longer can be", () => {
    const pg = driverError('relation "zq9" does not exist', { code: '42P01' });
    Object.defineProperty(pg, 'parameters', { value: ['zq9'], enumerable: false });
    expect(redactQueryParams(pg.message)).toBe(pg.message);
    expect(redactedMessage(pg)).toBe(REDACTED);
    expect(redactedMessage(duplicate())).toBe(`Failed query: ${STATEMENT}\nparams: ${REDACTED}`);
    expect(redactedMessage('plain text')).toBe('plain text');
  });

  it('hands back the same value where there is nothing to redact', () => {
    const event = { exception: { values: [{ value: 'kaboom', params: [1] }] } };
    expect(redactQueryParams(event)).toBe(event);
    expect(redactQueryParams('route params: id')).toBe('route params: id');
  });
});

/** A driver error as postgres-js throws it: its bound values ride non-enumerable, as there. */
function pgRefusal(message: string, fields: Record<string, unknown>, bound: unknown[]): Error {
  const pg = Object.assign(new Error(message), { severity: 'ERROR', ...fields });
  Object.defineProperty(pg, 'parameters', { value: bound, enumerable: false });
  return pg;
}

const DOCUMENT = '{"note":"zq9-secret-document"}';

function jsonRefusal(): Error {
  return pgRefusal(
    'invalid input syntax for type json',
    {
      code: '22P02',
      detail: 'Token "zq9" is invalid.',
      where: `JSON data, line 1: ${DOCUMENT.slice(0, 20)}...`,
      hint: 'Check zq9-secret-document',
      internal_query: `select '${DOCUMENT}'`,
      schema_name: 'public',
      table_name: 'notes',
      column_name: 'body',
      constraint_name: 'notes_body_check',
      routine: 'json_errsave_error',
    },
    [DOCUMENT],
  );
}

describe("redactQueryParams over a driver error's own fields", () => {
  it.each([
    ['logged by itself', (pg: Error) => redactQueryParams(stdSerializers.err(pg), pg)],
    ['with no error to read', (pg: Error) => redactQueryParams({ ...stdSerializers.err(pg) })],
    [
      'as the cause of a failed query',
      (pg: Error) =>
        redactQueryParams({
          details: { error: new DrizzleQueryError('select $1', [DOCUMENT], pg) },
        }),
    ],
  ])('keeps only the fields that name where it failed, %s', (_, redact) => {
    const text = JSON.stringify(redact(jsonRefusal()));
    expect(text).not.toContain('zq9');
    for (const kept of ['22P02', 'notes_body_check', 'notes', 'body', 'json_errsave_error']) {
      expect(text).toContain(kept);
    }
  });

  it('redacts a detail whatever its text says, as no template catalog can name every one', () => {
    const pg = pgRefusal('refused', { code: 'XX000', detail: 'The input zq9 was refused.' }, []);
    expect(JSON.stringify(redactQueryParams({ ...stdSerializers.err(pg) }))).not.toContain('zq9');
  });

  it.each([
    ['a JSON refusal', `JSON data, line 1: ${DOCUMENT}`, `JSON data, line 1: ${REDACTED}`],
    [
      'a bound parameter',
      "unnamed portal parameter $1 = 'zq9'",
      `unnamed portal parameter $1 = ${REDACTED}`,
    ],
    [
      'a tsquery with no operand',
      'no operand in tsquery: "zq9"',
      `no operand in tsquery: ${REDACTED}`,
    ],
    [
      'a tsquery it cannot parse',
      'syntax error in tsquery: "zq9 &"',
      `syntax error in tsquery: ${REDACTED}`,
    ],
  ])("redacts the value %s's text quotes, with no error to read", (_, text, kept) => {
    expect(redactQueryParams({ reason: `refused: ${text}` }).reason).toBe(`refused: ${kept}`);
  });
});

/** Each way a value's text reaches a serializer through what it calls, not a field it holds. */
const SERIALIZER_HOOKS: [string, (text: string) => unknown][] = [
  ['its own toJSON', (text) => ({ toJSON: () => text })],
  ['a toJSON it inherits', (text) => Object.create({ toJSON: () => text })],
  ['a toJSON on a function', (text) => Object.assign(() => 'ordinary', { toJSON: () => text })],
  [
    'a getter',
    (text) => Object.defineProperty({}, 'reason', { get: () => text, enumerable: true }),
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
  [
    'a field of a class instance',
    (text) =>
      new (class Reading {
        reason = text;
      })(),
  ],
  [
    'a toJSON inside a tagged object',
    (text) => ({ [Symbol.toStringTag]: 'Reading', reason: { toJSON: () => text } }),
  ],
];

/** Whether `value` is a primitive's box, which a serializer renders through its toPrimitive. */
function boxed(value: object): boolean {
  for (const unbox of [String, Number, Boolean, BigInt, Symbol]) {
    try {
      (unbox.prototype.valueOf as (this: unknown) => unknown).call(value);
      return true;
    } catch {}
  }
  return false;
}

/** Whether a serializer renders `value` without calling any code of the caller's. */
function inert(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return true;
  const obj = value as Record<string, unknown>;
  if (typeof obj.toJSON === 'function' || boxed(obj)) return false;
  if (typeof value === 'function') return true;
  return Object.keys(obj).every((key) => {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    return d !== undefined && 'value' in d && inert(d.value);
  });
}

describe('redactQueryParams, given a value whose text only a serializer renders', () => {
  describe.each(SERIALIZER_HOOKS)('through %s', (_, hook) => {
    it.each([
      ['a failed query', () => duplicate().message],
      ['a value the database quotes', () => 'invalid input syntax for type uuid: "zq9"'],
    ])('hands back what renders none of %s, and calls nothing when rendered', (_, text) => {
      for (const value of [hook(text()), { reading: hook(text()) }, [hook(text())]]) {
        const out = redactQueryParams(value);
        expect(inert(out)).toBe(true);
        const rendered = JSON.stringify(out) ?? '';
        expect(rendered).not.toContain(HASH);
        expect(rendered).not.toContain(EMAIL);
        expect(rendered).not.toContain('zq9');
      }
    });

    it('withholds a driver message read against the error beside it', () => {
      const pg = pgRefusal('relation "zq" does not exist', { code: '42P01' }, ['zq']);
      const out = redactQueryParams({ error: pg, reading: hook(pg.message) });
      expect(inert(out)).toBe(true);
      expect(JSON.stringify(out)).not.toContain('zq');
    });
  });

  it('renders what a serializer would once, so a hook that answers twice is not asked again', () => {
    const text = duplicate().message;
    let reads = 0;
    const getter = Object.defineProperty({}, 'reason', {
      get: () => (++reads === 1 ? 'ordinary' : text),
      enumerable: true,
    });
    let calls = 0;
    const later = { toJSON: () => (++calls === 1 ? 'ordinary' : text) };
    const when = new Date(Date.UTC(2026, 9, 7));
    let asked = 0;
    when.toISOString = () => (++asked === 1 ? 'ordinary' : text);
    const rendered = JSON.stringify(redactQueryParams({ getter, later, when }));
    expect([reads, calls, asked]).toEqual([1, 1, 1]);
    expect(rendered).toBe('{"getter":{"reason":"ordinary"},"later":"ordinary","when":"ordinary"}');
  });

  it('writes a hook that throws as redacted, and throws nothing itself', () => {
    let reads = 0;
    const value = {
      always: Object.defineProperty({}, 'reason', {
        get: () => {
          throw new Error(duplicate().message);
        },
        enumerable: true,
      }),
      second: Object.defineProperty({}, 'reason', {
        get: () => {
          if (++reads > 1) throw new Error('read twice');
          return 'ordinary';
        },
        enumerable: true,
      }),
      rendered: {
        toJSON: () => {
          throw new Error(duplicate().message);
        },
      },
    };
    const rendered = JSON.stringify(redactQueryParams(value));
    expect(reads).toBe(1);
    expect(rendered).toBe(
      `{"always":{"reason":"${REDACTED}"},"second":{"reason":"ordinary"},"rendered":"${REDACTED}"}`,
    );
  });

  it('reads an error that renders through its own toJSON for the values its siblings repeat', () => {
    const pg = Object.assign(pgRefusal('relation "zq" does not exist', { code: '42P01' }, ['zq']), {
      toJSON: () => 'ordinary',
    });
    const rendered = JSON.stringify(redactQueryParams({ error: pg, reading: pg.message }));
    expect(rendered).not.toContain('zq');
    expect(JSON.parse(rendered).error).toBe('ordinary');
    const wrapped = { toJSON: () => ({ error: pg, reading: pg.message }) };
    expect(JSON.stringify(redactQueryParams({ wrapped }))).not.toContain('zq');
    const direct = {
      toJSON: () => pgRefusal('relation "zq" does not exist', { code: '42P01' }, ['zq']),
    };
    expect(JSON.stringify(redactQueryParams({ direct, reading: pg.message }))).not.toContain('zq');
  });

  it('reads an array as JSON does: each index once, one that throws written redacted', () => {
    let reads = 0;
    const items: unknown[] = ['kept'];
    Object.defineProperty(items, 1, {
      get: () => (++reads === 1 ? 'ordinary' : duplicate().message),
      enumerable: true,
    });
    Object.defineProperty(items, 2, {
      get: () => {
        throw new Error(duplicate().message);
      },
      enumerable: true,
    });
    const rendered = JSON.stringify(redactQueryParams({ items }));
    expect(reads).toBe(1);
    expect(rendered).toBe(`{"items":["kept","ordinary","${REDACTED}"]}`);
  });

  it('redacts a payload that holds itself, writing [Circular] where it does', () => {
    const loop: Record<string, unknown> = { reason: duplicate().message };
    loop.again = loop;
    loop.onceMore = loop;
    const rendered = JSON.stringify(redactQueryParams({ loop }));
    expect(rendered).not.toContain(HASH);
    expect(rendered).toContain('"again":"[Circular]","onceMore":"[Circular]"');
  });

  it('leaves a serializer no getter to read again, though it rendered nothing to redact', () => {
    let reads = 0;
    const value = {
      reading: Object.defineProperty({}, 'reason', {
        get: () => {
          reads++;
          return 'ordinary';
        },
        enumerable: true,
      }),
    };
    const out = redactQueryParams(value);
    const asked = reads;
    expect(JSON.stringify(out)).toBe('{"reading":{"reason":"ordinary"}}');
    expect(reads).toBe(asked);
  });

  it('hands back none of the functions a toJSON rendered, which no serializer calls there', () => {
    const text = duplicate().message;
    const value = { reading: { toJSON: () => ({ toJSON: () => text, note: 'kept' }) } };
    expect(JSON.stringify(value)).toBe('{"reading":{"note":"kept"}}');
    expect(JSON.stringify(redactQueryParams(value))).toBe('{"reading":{"note":"kept"}}');
  });

  it('asks toJSON for the key a serializer passes it', () => {
    const text = duplicate().message;
    const value = { reading: { toJSON: (key: string) => (key === 'reading' ? text : 'ordinary') } };
    const rendered = JSON.stringify(redactQueryParams(value));
    expect(rendered).not.toContain(HASH);
    expect(rendered).toContain(STATEMENT.slice(0, 12));
  });

  it('keeps what a hook renders when it carries nothing to redact', () => {
    const when = new Date(Date.UTC(2026, 9, 7));
    const value = {
      when,
      reading: { toJSON: () => 'a reading' },
      name: new String('a name'),
      tagged: { [Symbol.toStringTag]: 'Reading', reason: 'ordinary' },
    };
    expect(JSON.stringify(redactQueryParams(value))).toBe(JSON.stringify(value));
  });

  it('still hands back the same data where there is nothing to redact', () => {
    const value = { reason: 'ordinary', nested: [{ id: 1 }] };
    expect(redactQueryParams(value)).toBe(value);
  });
});
