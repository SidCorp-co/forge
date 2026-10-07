// ISS-1383 — the redact paths pino censors are censored before any hook of the caller's reads them.

import { describe, expect, it } from 'vitest';
import { capture, failedInsert, HASH } from './logger.fixture.js';

describe("the core logger's redact paths, censored before a hook reads them", () => {
  it("asks a value's toJSON with the fields the logger censors by name already censored", () => {
    const { lines, log } = capture();
    const reading = () => ({
      password: 'ordinary-password',
      toJSON() {
        return { said: this.password };
      },
    });
    log.warn({ reading: reading() }, 'read');
    log.child({ reading: reading() }).warn('bound');
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings({ reading: reading() });
    rebound.warn('rebound');
    log.warn(
      {
        dated: {
          password: 'ordinary-password',
          when: new Date(0),
          toJSON() {
            return { said: this.password, when: this.when.toISOString() };
          },
        },
      },
      'dated',
    );
    const request = () => ({
      headers: { authorization: 'ordinary-secret' },
      toJSON() {
        return this.headers.authorization;
      },
    });
    const shared = () => {
      const headers = { authorization: 'ordinary-secret' };
      const req = {
        first: headers,
        headers,
        toJSON() {
          return this.headers.authorization;
        },
      };
      (headers as Record<string, unknown>).back = req;
      return req;
    };
    let got = 0;
    const captured = () => ({
      password: 'ordinary-password',
      get toJSON() {
        got++;
        const saved = this.password;
        return () => ({ said: saved });
      },
    });
    log.warn({ reading: captured() }, 'captured');
    log.child({ reading: captured() }).warn('bound captured');
    log.warn({ req: shared() }, 'shared');
    log.child({ req: shared() }).warn('bound shared');
    log.warn({ req: request() }, 'request');
    log.child({ req: request() }).warn('bound request');
    rebound.setBindings({ req: request() });
    rebound.warn('rebound request');
    expect(lines).toHaveLength(11);
    expect(got).toBe(2);
    expect(JSON.parse(lines[3] ?? '').dated).toEqual({
      said: '[Redacted]',
      when: '1970-01-01T00:00:00.000Z',
    });
    for (const line of lines) {
      expect(line).not.toContain('ordinary-secret');
      expect(line).not.toContain('ordinary-password');
      expect(line).not.toContain('ordinary-token');
    }
  });

  it('censors a redact path reached through a getter before a toJSON reads it, and puts it back', () => {
    const { lines, log } = capture();
    const headers = { authorization: 'ordinary-secret' };
    const req = () => ({
      get headers() {
        return headers;
      },
      toJSON() {
        return this.headers.authorization;
      },
    });
    log.warn({ req: req() }, 'read');
    log.child({ req: req() }).warn('bound');
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings({ req: req() });
    rebound.warn('rebound');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toContain('ordinary-secret');
    expect(headers.authorization).toBe('ordinary-secret');
  });

  it("censors a JSON format argument's redact paths before its toJSON reads them, as pino does", () => {
    const { lines, log } = capture();
    const hooked = () => ({
      password: 'ordinary-password',
      toJSON() {
        return { said: this.password };
      },
    });
    const auth = () => ({
      headers: { authorization: 'ordinary-secret' },
      toJSON() {
        return { said: this.headers.authorization };
      },
    });
    const kept = hooked();
    log.warn('j %j', kept);
    log.warn('j %j', { reading: hooked() });
    log.warn('o %o', auth());
    log.child({ requestId: 'r1' }).warn({ n: 1 }, 'O %O', auth());
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual([
      'j {"said":"[Redacted]"}',
      'j {"reading":{"said":"[Redacted]"}}',
      'o {"said":"[Redacted]"}',
      'O {"said":"[Redacted]"}',
    ]);
    expect(kept.password).toBe('ordinary-password');
  });
});

describe("the core logger's redact paths, read through getters", () => {
  it('reads a getter on a censored path once, sharing that read with what it writes', () => {
    const { lines, log } = capture();
    let reads = 0;
    const fields = () => {
      let mine = 0;
      return Object.defineProperty({}, 'reading', {
        get: () => {
          reads++;
          if (++mine > 1) throw new Error('read twice');
          return { note: 'ordinary' };
        },
        enumerable: true,
      });
    };
    log.warn(fields(), 'read');
    expect(reads).toBe(1);
    log.child(fields()).warn('bound');
    expect(reads).toBe(2);
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings(fields());
    rebound.warn('rebound');
    expect(reads).toBe(3);
    expect(lines.map((line) => JSON.parse(line).reading)).toEqual([
      { note: 'ordinary' },
      { note: 'ordinary' },
      { note: 'ordinary' },
    ]);
  });

  it('censors a redact path reached through an inherited getter, or one that answers anew', () => {
    const { lines, log } = capture();
    let made = 0;
    class Request {
      get headers(): { authorization: string } {
        made++;
        return { authorization: 'ordinary-secret' };
      }
      toJSON() {
        return this.headers.authorization;
      }
    }
    const reqs = [new Request(), new Request(), new Request()];
    log.warn({ req: reqs[0] }, 'read');
    log.child({ req: reqs[1] }).warn('bound');
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings({ req: reqs[2] });
    rebound.warn('rebound');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(JSON.parse(line).req).toBe('[Redacted]');
    expect(made).toBe(3);
    for (const req of reqs) expect(Object.getOwnPropertyNames(req)).toEqual([]);
  });

  it("reads a getter's answer only once every field censored by name is censored", () => {
    const { lines, log } = capture();
    const byData = () => ({
      headers: { authorization: 'ordinary-secret' },
      get echo() {
        return this.headers.authorization;
      },
      get auth() {
        return { said: this.headers.authorization };
      },
    });
    const byGetter = () => {
      const headers = { authorization: 'ordinary-secret' };
      return {
        get echo() {
          return this.headers.authorization;
        },
        get headers() {
          return headers;
        },
      };
    };
    for (const fields of [byData, byGetter]) {
      log.warn(fields(), 'read');
      log.child(fields()).warn('bound');
      const rebound = log.child({ requestId: 'r1' });
      rebound.setBindings(fields());
      rebound.warn('rebound');
    }
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).not.toContain('ordinary-secret');
      expect(JSON.parse(line).echo).toBe('[Redacted]');
    }
    expect(JSON.parse(lines[0] ?? '').auth).toEqual({ said: '[Redacted]' });
  });

  it('keeps what a getter on a censored path threw, reading it once', () => {
    const { lines, log } = capture();
    let reads = 0;
    log.warn(
      Object.defineProperty({ reason: HASH }, 'reading', {
        get: () => {
          if (++reads === 1) throw failedInsert();
          return { note: 'ordinary' };
        },
        enumerable: true,
      }),
      'read',
    );
    expect(reads).toBe(1);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain(HASH);
    expect(JSON.parse(line).reading).toBe('[Redacted]');
  });
});

describe("the core logger's redact paths, on fields it cannot redefine", () => {
  it("censors a field held by an accessor without calling the caller's setter", () => {
    const { lines, log } = capture();
    let stored = 'ordinary-password';
    let sets = 0;
    const held = () => ({
      get password() {
        return stored;
      },
      set password(value: string) {
        sets++;
        stored = value;
      },
      toJSON() {
        return { said: this.password };
      },
    });
    log.warn(held(), 'top');
    log.warn({ reading: held() }, 'nested');
    log.child({ reading: held() }).warn('bound');
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings({ reading: held() });
    rebound.warn('rebound');
    expect([sets, stored]).toEqual([0, 'ordinary-password']);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).not.toContain('ordinary-password');
    expect(JSON.parse(lines[1] ?? '').reading).toEqual({ said: '[Redacted]' });
  });

  it('censors a field that cannot be redefined by assigning it, and puts it back', () => {
    const { lines, log } = capture();
    const fixed = (): { password: string } => {
      const reading = {
        toJSON() {
          return { said: (this as unknown as { password: string }).password };
        },
      };
      return Object.defineProperty(reading, 'password', {
        value: 'ordinary-password',
        writable: true,
        enumerable: true,
        configurable: false,
      }) as unknown as { password: string };
    };
    const held = [fixed(), fixed(), fixed()];
    log.warn({ reading: held[0] }, 'read');
    log.child({ reading: held[1] }).warn('bound');
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings({ reading: held[2] });
    rebound.warn('rebound');
    expect(lines.map((line) => JSON.parse(line).reading)).toEqual([
      { said: '[Redacted]' },
      { said: '[Redacted]' },
      { said: '[Redacted]' },
    ]);
    expect(held.map((h) => h.password)).toEqual(Array(3).fill('ordinary-password'));
  });

  it('runs no code of an object holding a field it cannot censor, keeping its data fields', () => {
    const { lines, log } = capture();
    let ran = 0;
    const frozen = () =>
      Object.freeze({
        password: 'ordinary-password',
        note: 'kept',
        get shown() {
          ran++;
          return this.password;
        },
      });
    const hooked = () =>
      Object.freeze({
        password: 'ordinary-password',
        toJSON() {
          ran++;
          return { said: this.password };
        },
      });
    log.warn({ reading: hooked(), plain: frozen() }, 'read');
    log.child({ reading: hooked(), plain: frozen() }).warn('bound');
    const rebound = log.child({ requestId: 'r1' });
    rebound.setBindings({ reading: hooked(), plain: frozen() });
    rebound.warn('rebound');
    log.warn(frozen(), 'top');
    expect(ran).toBe(0);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).not.toContain('ordinary-password');
    for (const line of lines.slice(0, 3)) {
      expect(JSON.parse(line)).toMatchObject({
        reading: '[Redacted]',
        plain: { password: '[Redacted]', note: 'kept', shown: '[Redacted]' },
      });
    }
    expect(JSON.parse(lines[3] ?? '')).toMatchObject({ note: 'kept', shown: '[Redacted]' });
  });
});
