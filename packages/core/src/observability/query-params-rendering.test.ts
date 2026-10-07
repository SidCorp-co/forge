// ISS-1383 — a value is redacted as a serializer renders it, each hook of the caller's run once.

import {
  type FieldReads,
  REDACTED,
  readOnce,
  redactedMessage,
  redactQueryParams,
} from '@forge/observability';
import { describe, expect, it } from 'vitest';
import { duplicate, EMAIL, HASH, pgRefusal, STATEMENT } from './query-params.fixture.js';

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
    const hidden = { error: pg, toJSON: () => 'ordinary' };
    const rendered2 = JSON.stringify(redactQueryParams({ hidden, reading: pg.message }));
    expect(rendered2).not.toContain('zq');
    expect(JSON.parse(rendered2).hidden).toBe('ordinary');
    const direct = {
      toJSON: () => pgRefusal('relation "zq" does not exist', { code: '42P01' }, ['zq']),
    };
    expect(JSON.stringify(redactQueryParams({ direct, reading: pg.message }))).not.toContain('zq');
  });

  it('leaves no toJSON getter for a serializer to read again, though it gave no function', () => {
    let reads = 0;
    const reading = Object.defineProperty({ note: 'kept' }, 'toJSON', {
      get: () => (++reads === 1 ? undefined : () => duplicate().message),
    });
    const rendered = JSON.stringify(redactQueryParams({ reading }));
    expect(reads).toBe(1);
    expect(rendered).toBe('{"reading":{"note":"kept"}}');
    for (const wrap of [(f: unknown) => f, (f: unknown) => [f]]) {
      let asked = 0;
      const fn = Object.defineProperty(() => 'ordinary', 'toJSON', {
        get: () => (++asked === 1 ? undefined : () => duplicate().message),
      });
      const out = JSON.stringify(redactQueryParams(wrap(fn)));
      expect(asked).toBe(1);
      expect(out ?? '').not.toContain(HASH);
      expect(out ?? '').not.toContain('Failed query');
    }
  });
});

describe('redactQueryParams, given a hook that throws, loops back or cannot be read', () => {
  it('writes a toJSON handing back its own object by its fields, and a way back to it as a cycle', () => {
    let asked = 0;
    const self = {
      note: 'kept',
      toJSON() {
        asked++;
        return this;
      },
    };
    const back: Record<string, unknown> = {
      note: 'kept',
      toJSON() {
        asked++;
        return { back: this, note: this.note };
      },
    };
    const loop: Record<string, unknown> = {
      toJSON() {
        asked++;
        return this;
      },
    };
    loop.again = loop;
    expect(JSON.stringify(redactQueryParams({ self }))).toBe('{"self":{"note":"kept"}}');
    expect(JSON.stringify(redactQueryParams({ back }))).toBe(
      '{"back":{"back":"[Circular]","note":"kept"}}',
    );
    expect(JSON.stringify(redactQueryParams({ loop }))).toBe('{"loop":{"again":"[Circular]"}}');
    expect(asked).toBe(3);
  });

  it('reads a value against the error a hook of it threw, writing the hook redacted', () => {
    const thrower = () => () => {
      throw duplicate();
    };
    const values = [
      {
        reason: HASH,
        held: Object.defineProperty({}, 'reason', { get: thrower(), enumerable: true }),
      },
      { reason: HASH, held: { toJSON: thrower() } },
      { reason: HASH, held: Object.defineProperty({ note: 'kept' }, 'toJSON', { get: thrower() }) },
      {
        reason: HASH,
        held: new Proxy([], {
          get: (target, key) => (key === 'length' ? thrower()() : Reflect.get(target, key)),
        }),
      },
      { reason: HASH, held: Object.assign(new String('kept'), { toString: thrower() }) },
    ];
    for (const value of values) {
      const rendered = JSON.stringify(redactQueryParams(value));
      expect(rendered).not.toContain(HASH);
      expect(rendered).not.toContain('Failed query');
    }
  });

  it('writes a value it cannot read at all as redacted, throwing nothing itself', () => {
    const trap = () => {
      throw duplicate();
    };
    const hostile = new Proxy(
      {},
      { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap, ownKeys: trap },
    );
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const unreadable of [hostile, revoked]) {
      expect(redactQueryParams(unreadable)).toBe(REDACTED);
      const out = JSON.stringify(redactQueryParams({ reading: unreadable, reason: 'kept' }));
      expect(out).toBe('{"reading":"[Redacted]","reason":"kept"}');
    }
    for (const unreadable of [hostile, revoked]) {
      const answered = Object.defineProperty({ reason: 'kept' }, 'reading', {
        get: () => unreadable,
        enumerable: true,
      });
      expect(JSON.stringify(redactQueryParams(answered))).toBe(
        '{"reason":"kept","reading":"[Redacted]"}',
      );
    }
    let listed = 0;
    const once = new Proxy(
      { note: 'kept' },
      {
        ownKeys: (target) => {
          if (++listed > 1) throw duplicate();
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(redactQueryParams(once)).toBe(REDACTED);
    // An error that cannot be read cannot name the values to find: the text it came with is withheld.
    expect(redactQueryParams('text', revoked)).toBe(REDACTED);
    expect(redactQueryParams('text', [revoked, hostile])).toBe(REDACTED);
    expect(redactedMessage(revoked)).toBe(REDACTED);
    expect(redactedMessage(hostile)).toBe(REDACTED);
    // What the unreadable value threw still names the values to find beside it.
    expect(JSON.stringify(redactQueryParams({ reading: hostile, reason: HASH }))).not.toContain(
      HASH,
    );
  });

  it('reads an enumerable toJSON getter once, for the hook and for the fields alike', () => {
    let reads = 0;
    const reading = Object.defineProperty({ note: 'kept' }, 'toJSON', {
      get: () => {
        if (++reads > 1) throw new Error(duplicate().message);
        return undefined;
      },
      enumerable: true,
    });
    const out = redactQueryParams({ reading });
    expect(reads).toBe(1);
    expect(JSON.stringify(out)).toBe('{"reading":{"note":"kept"}}');
    expect(reads).toBe(1);
  });
});

describe('redactQueryParams, reading a value as JSON reads it', () => {
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

  it('writes what a value held when it was read, though a later hook changed it', () => {
    let asked = 0;
    const early: Record<string, unknown> = { note: 'kept' };
    const items: unknown[] = ['kept'];
    const value = {
      early,
      items,
      get later() {
        Object.defineProperty(early, 'toJSON', {
          value: () => {
            asked++;
            return duplicate().message;
          },
        });
        early.note = HASH;
        items.push(HASH);
        return 'kept';
      },
    };
    const out = redactQueryParams(value);
    expect(JSON.stringify(out)).toBe('{"early":{"note":"kept"},"items":["kept"],"later":"kept"}');
    expect(asked).toBe(0);
  });

  it('still hands back the same data where there is nothing to redact', () => {
    const value = { reason: 'ordinary', nested: [{ id: 1 }] };
    expect(redactQueryParams(value)).toBe(value);
  });
});

describe('readOnce', () => {
  class Held {
    note = 'own';
    get computed(): { at: number } {
      reads++;
      return { at: reads };
    }
  }
  Object.defineProperty(Held.prototype, 'shared', { value: 'inherited', enumerable: false });
  let reads = 0;

  it('reads an inherited field and an inherited getter, the getter once across one set of reads', () => {
    reads = 0;
    const held = new Held();
    const seen: FieldReads = new WeakMap();
    expect(readOnce(held, 'note', seen)).toEqual({ value: 'own', called: false, threw: false });
    expect(readOnce(held, 'shared', seen).value).toBe('inherited');
    const first = readOnce(held, 'computed', seen);
    expect(first).toEqual({ value: { at: 1 }, called: true, threw: false });
    expect(readOnce(held, 'computed', seen).value).toBe(first.value);
    expect(reads).toBe(1);
    expect(readOnce(held, 'missing', seen).value).toBeUndefined();
  });

  it('writes a getter that throws redacted, says it threw, and remembers that too', () => {
    let asked = 0;
    const broken = Object.defineProperty({}, 'reason', {
      get: () => {
        asked++;
        throw new Error(duplicate().message);
      },
    });
    const seen: FieldReads = new WeakMap();
    const first = readOnce(broken, 'reason', seen);
    expect(first).toMatchObject({ value: REDACTED, called: true, threw: true });
    expect((first.error as Error).message).toBe(duplicate().message);
    expect(readOnce(broken, 'reason', seen).error).toBe(first.error);
    expect(asked).toBe(1);
  });

  it('runs nothing where it is told not to, answering what it has not read as redacted', () => {
    reads = 0;
    const held = new Held();
    expect(readOnce(held, 'computed', new WeakMap(), false).value).toBe(REDACTED);
    expect(readOnce(held, 'note', new WeakMap(), false).value).toBe('own');
    expect(reads).toBe(0);
  });
});
