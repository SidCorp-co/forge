// ISS-1383 — what the logger writes is what pino would render, each hook of the caller's run once.

import { describe, expect, it } from 'vitest';
import {
  answering,
  capture,
  EMAIL,
  failedInsert,
  HASH,
  hostile,
  relationRefusal,
  revoked,
  SERIALIZER_HOOKS,
} from './logger.fixture.js';

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
    log.warn({ error: pg }, '100%% read: %s', hook(pg.message));
    log.warn(
      { err: hook('invalid input syntax for type uuid: "zq9"') as never },
      'blind %s',
      hook('invalid input syntax for type uuid: "zq9"'),
    );
    expect(lines).toHaveLength(4);
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

  it('reads each hook once and writes one that throws as redacted, throwing nothing itself', () => {
    const { lines, log } = capture();
    let reads = 0;
    let asked = 0;
    const when = new Date(Date.UTC(2026, 9, 7));
    when.toISOString = () => (++asked === 1 ? 'ordinary' : failedInsert().message);
    const payload = {
      once: Object.defineProperty({}, 'reason', {
        get: () => {
          if (++reads > 1) throw new Error('read twice');
          return 'ordinary';
        },
        enumerable: true,
      }),
      broken: Object.defineProperty({}, 'reason', {
        get: () => {
          throw new Error(failedInsert().message);
        },
        enumerable: true,
      }),
      when,
    };
    log.warn(payload, 'read');
    expect([reads, asked]).toEqual([1, 1]);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '');
    expect(line.once.reason).toBe('ordinary');
    expect(line.broken.reason).toBe('[Redacted]');
    expect(line.when).toBe('ordinary');
  });

  it('writes a payload that holds itself, marking where it does', () => {
    const { lines, log } = capture();
    const loop: Record<string, unknown> = { reason: failedInsert().message };
    loop.again = loop;
    loop.onceMore = loop;
    log.warn({ loop }, 'read');
    log.child({ loop }).warn('bound');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(HASH);
      expect(line).toContain('[Circular]');
    }
  });

  it('withholds a driver message rendered from its own error, as a format argument or a prefixed message', () => {
    const { lines, log } = capture();
    log.warn('read %s', relationRefusal());
    log.warn({ requestId: 'r1' }, 'read %s', relationRefusal());
    log.child({}, { msgPrefix: 'read: ' }).warn({ requestId: 'r2' }, relationRefusal() as never);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toContain('zq');
  });
});

describe('the core logger, given a value it cannot read', () => {
  it('reads the rest of a call against the error a coercion threw', () => {
    const { lines, log } = capture();
    const throwing = {
      toString(): string {
        throw failedInsert();
      },
    };
    log.warn('read %s %s', throwing, HASH);
    log.warn({ reason: HASH }, 'read %s', throwing);
    log.child({}, { msgPrefix: 'read: ' }).warn({ reason: HASH }, throwing as never);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain(HASH);
      expect(line).not.toContain('Failed query');
    }
  });

  it('writes a line for fields that cannot be listed, throwing nothing itself', () => {
    const { lines, log } = capture();
    const unlisted = () =>
      new Proxy(
        { note: 'kept' },
        {
          ownKeys: () => {
            throw failedInsert();
          },
        },
      );
    expect(() => log.warn(unlisted(), 'read')).not.toThrow();
    expect(() => log.warn({ reading: unlisted() }, 'nested')).not.toThrow();
    expect(() => log.child(unlisted()).warn('bound')).not.toThrow();
    const rebound = log.child({ requestId: 'r1' });
    expect(() => rebound.setBindings(unlisted())).not.toThrow();
    rebound.warn('rebound');
    log.warn('after');
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      JSON.parse(line);
      expect(line).not.toContain(HASH);
    }
    expect(JSON.parse(lines[1] ?? '').reading).toBe('[Redacted]');
  });

  it.each([
    ['every read of which throws', () => hostile()],
    ['that is a revoked proxy', () => revoked()],
  ])('writes a line for a value %s, throwing nothing itself', (_, make) => {
    const { lines, log } = capture();
    const calls: [string, () => void][] = [
      ['merging object', () => log.warn(make(), 'read')],
      ['field', () => log.warn({ reading: make(), err: make() }, 'read')],
      ['%s', () => log.warn('read %s', make())],
      ['%j', () => log.warn('read %j', make())],
      ['first argument', () => log.warn(make() as never)],
      ['child', () => log.child(make()).warn('bound')],
      ['child field', () => log.child({ reading: make() }).warn('bound')],
      ['prefixed', () => log.child({}, { msgPrefix: 'read: ' }).warn(make() as never)],
      ['setBindings', () => log.child({ requestId: 'r1' }).setBindings(make())],
      ['getter answer', () => log.warn(answering(make()), 'read')],
      ['bound getter answer', () => log.child(answering(make())).warn('bound')],
    ];
    for (const [name, call] of calls) expect(call, name).not.toThrow();
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      JSON.parse(line);
      expect(line).not.toContain(HASH);
    }
  });

  it('writes a text whose coercion throws as redacted, throwing nothing itself', () => {
    const { lines, log } = capture();
    const throwing = () => ({
      get reason(): string {
        throw new Error(failedInsert().message);
      },
      toString(): string {
        throw new Error(failedInsert().message);
      },
    });
    const primitive = {
      [Symbol.toPrimitive]: () => {
        throw new Error(failedInsert().message);
      },
    };
    expect(() => log.warn('read %s', throwing())).not.toThrow();
    expect(() => log.warn('read %s', primitive)).not.toThrow();
    const prefixed = log.child({}, { msgPrefix: 'read: ' });
    expect(() => prefixed.warn({ requestId: 'r1' }, throwing() as never)).not.toThrow();
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual([
      'read [Redacted]',
      'read [Redacted]',
      'read: [Redacted]',
    ]);
    for (const line of lines) {
      expect(line).not.toContain(HASH);
      expect(line).not.toContain(EMAIL);
    }
  });
});

describe('the core logger, rendering a call as pino does', () => {
  it('asks a field toJSON with the empty key, as pino stringifies each field alone', () => {
    const { lines, log } = capture();
    const reading = () => ({ toJSON: (key: string) => (key === '' ? 'kept' : undefined) });
    log.warn({ reading: reading() }, 'read');
    log.child({ reading: reading() }).warn('bound');
    expect(lines.map((line) => JSON.parse(line).reading)).toEqual(['kept', 'kept']);
  });

  it('never asks the merging object or bindings for a toJSON, which pino does not', () => {
    const { lines, log } = capture();
    let asked = 0;
    const fields = () => ({
      password: 'ordinary-password',
      note: 'kept',
      toJSON() {
        asked++;
        return { leaked: this.password };
      },
    });
    log.warn(fields(), 'read');
    log.child(fields()).warn('bound');
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings(fields());
    rebound.warn('rebound');
    expect(asked).toBe(0);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain('ordinary-password');
      expect(JSON.parse(line).note).toBe('kept');
    }
  });

  it('keeps what a format argument renders when it carries nothing to redact', () => {
    const { lines, log } = capture();
    log.warn('read %s and %s', { toString: () => 'a reading' }, new URL('https://example.test/x'));
    expect(JSON.parse(lines[0] ?? '').msg).toBe('read a reading and https://example.test/x');
  });
});
