/**
 * The presence contract (ISS-1034): defaults equal the constants the guards
 * were tuned at, every key folds by its own operator, an unset key folds as
 * its default, and a bad payload is refused naming the key or the bound.
 */
import { describe, expect, it, vi } from 'vitest';

// cm:why `proactivity.js` is imported only for its four constants, and it reaches `db/client.js`, which validates env at import — mocked so this pure-function suite needs no DATABASE_URL
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../db/client.js', () => ({ db: {} }));

import {
  foldPresence,
  heartbeatOf,
  namesHandle,
  PRESENCE_BOUNDS,
  PRESENCE_DEFAULTS,
  PresenceValidationError,
  validatePresence,
  windowNamesAHandle,
} from './presence.js';
import { BACKOFF_AFTER, DORMANT_MS, LOOP_BOUNCE_MS, LOOP_LIMIT } from './proactivity.js';

describe('PRESENCE_DEFAULTS', () => {
  it("equal today's proactivity constants, so an unset self changes nothing (criterion 32)", () => {
    expect(PRESENCE_DEFAULTS.dormantMs).toBe(DORMANT_MS);
    expect(PRESENCE_DEFAULTS.backoffAfter).toBe(BACKOFF_AFTER);
    expect(PRESENCE_DEFAULTS.loopBounceMs).toBe(LOOP_BOUNCE_MS);
    expect(PRESENCE_DEFAULTS.loopLimit).toBe(LOOP_LIMIT);
  });
});

describe('foldPresence', () => {
  it('folds nothing to the defaults', () => {
    expect(foldPresence([])).toEqual({
      dormantMs: DORMANT_MS,
      backoffAfter: BACKOFF_AFTER,
      loopBounceMs: LOOP_BOUNCE_MS,
      loopLimit: LOOP_LIMIT,
      answerInGroup: 'window',
    });
    expect(foldPresence([{}, {}])).toEqual(foldPresence([]));
  });

  it.each([
    ['dormantMs', { a: 120_000, b: 600_000 }, 120_000],
    ['backoffAfter', { a: 1, b: 5 }, 1],
    ['loopBounceMs', { a: 60_000, b: 900_000 }, 900_000],
    ['loopLimit', { a: 2, b: 7 }, 2],
  ] as const)('folds %s by its own operator (criterion 34)', (key, values, expected) => {
    const folded = foldPresence([{ [key]: values.a }, { [key]: values.b }]);
    expect(folded[key]).toBe(expected);
    expect(foldPresence([{ [key]: values.b }, { [key]: values.a }])[key]).toBe(expected);
  });

  it('answerInGroup: mention wins over window (criterion 34)', () => {
    expect(
      foldPresence([{ answerInGroup: 'window' }, { answerInGroup: 'mention' }]).answerInGroup,
    ).toBe('mention');
    expect(foldPresence([{ answerInGroup: 'window' }, {}]).answerInGroup).toBe('window');
  });

  // cm:guard the default JOINS the fold as a value: one handle loosening a guard beside one that said nothing folds to the tighter of the two, which is the default (codex F4).
  it('a handle that left a key unset votes its default, so one loosening cannot govern (criterion 35)', () => {
    expect(foldPresence([{ backoffAfter: 20 }, {}]).backoffAfter).toBe(BACKOFF_AFTER);
    expect(foldPresence([{ loopBounceMs: 60_000 }, {}]).loopBounceMs).toBe(LOOP_BOUNCE_MS);
    expect(foldPresence([{ loopBounceMs: 60_000 }]).loopBounceMs).toBe(60_000);
    expect(foldPresence([{ dormantMs: 120_000 }, {}]).dormantMs).toBe(120_000);
  });

  it('a key one self leaves unset folds as that key’s default, not as zero (criterion 35)', () => {
    const folded = foldPresence([{ backoffAfter: 1 }, { dormantMs: 120_000 }]);
    expect(folded.backoffAfter).toBe(1);
    expect(folded.dormantMs).toBe(120_000);
    expect(folded.loopBounceMs).toBe(LOOP_BOUNCE_MS);
    expect(folded.loopLimit).toBe(LOOP_LIMIT);
  });

  it('never folds heartbeat: it is read per handle', () => {
    expect(heartbeatOf({})).toEqual({
      enabled: false,
      intervalMs: PRESENCE_DEFAULTS.heartbeatIntervalMs,
    });
    expect(heartbeatOf({ heartbeat: { enabled: true } })).toEqual({
      enabled: true,
      intervalMs: PRESENCE_DEFAULTS.heartbeatIntervalMs,
    });
    expect(heartbeatOf({ heartbeat: { intervalMs: 900_000 } }).intervalMs).toBe(900_000);
  });
});

describe('validatePresence', () => {
  it('accepts every key at its bounds', () => {
    expect(
      validatePresence({
        dormantMs: PRESENCE_BOUNDS.dormantMs[0],
        backoffAfter: PRESENCE_BOUNDS.backoffAfter[1],
        loopBounceMs: PRESENCE_BOUNDS.loopBounceMs[0],
        loopLimit: PRESENCE_BOUNDS.loopLimit[1],
        answerInGroup: 'mention',
        heartbeat: { enabled: true, intervalMs: PRESENCE_BOUNDS.heartbeatIntervalMs[0] },
      }),
    ).toMatchObject({ answerInGroup: 'mention', heartbeat: { enabled: true } });
    expect(validatePresence({})).toEqual({});
  });

  it('refuses an unknown key naming the accepted keys (criterion 39)', () => {
    expect(() => validatePresence({ chatty: true })).toThrow(PresenceValidationError);
    try {
      validatePresence({ chatty: true });
    } catch (err) {
      const e = err as PresenceValidationError;
      expect(e.issues[0]).toMatch(/unknown key\(s\) `chatty`/);
      expect(e.issues[0]).toMatch(
        /dormantMs, backoffAfter, loopBounceMs, loopLimit, answerInGroup, heartbeat/,
      );
    }
  });

  it('refuses an unknown heartbeat key naming its two keys', () => {
    try {
      validatePresence({ heartbeat: { every: 5 } });
      expect.unreachable();
    } catch (err) {
      expect((err as PresenceValidationError).issues[0]).toMatch(
        /presence\.heartbeat.*enabled, intervalMs/,
      );
    }
  });

  it.each([
    ['dormantMs', 59_999],
    ['backoffAfter', 21],
    ['loopBounceMs', 9_999],
    ['loopLimit', 0],
  ] as const)('refuses %s out of range naming the bound it broke (criterion 40)', (key, value) => {
    try {
      validatePresence({ [key]: value });
      expect.unreachable();
    } catch (err) {
      const [lo, hi] = PRESENCE_BOUNDS[key];
      expect((err as PresenceValidationError).issues[0]).toBe(
        `presence.${key}: presence.${key} must be between ${lo} and ${hi}`,
      );
    }
  });

  it('refuses a heartbeat interval out of range naming the bound', () => {
    try {
      validatePresence({ heartbeat: { intervalMs: 1 } });
      expect.unreachable();
    } catch (err) {
      expect((err as PresenceValidationError).issues[0]).toMatch(
        /presence\.heartbeat\.intervalMs: presence\.heartbeatIntervalMs must be between 300000 and 604800000/,
      );
    }
  });

  it('refuses a non-integer and a wrong mode', () => {
    expect(() => validatePresence({ backoffAfter: 1.5 })).toThrow(PresenceValidationError);
    expect(() => validatePresence({ answerInGroup: 'question' })).toThrow(PresenceValidationError);
  });
});

describe('namesHandle', () => {
  it('matches @handle and the bare handle as a word, case-insensitively', () => {
    expect(namesHandle('@babo can you check', 'babo')).toBe(true);
    expect(namesHandle('Babo, the build?', 'babo')).toBe(true);
    expect(namesHandle('ask babo.', 'babo')).toBe(true);
  });

  it('does not fire inside another word, on a hyphenated superset, or on a null handle', () => {
    expect(namesHandle('forgery is a crime', 'forge')).toBe(false);
    expect(namesHandle('@forge-dev please', 'forge')).toBe(false);
    expect(namesHandle('@forge please', null)).toBe(false);
  });

  it('reads every message in the window against every handle', () => {
    const messages = [{ content: 'the build' }, { content: 'I mean @babo' }];
    expect(windowNamesAHandle(messages, [null, 'babo'])).toBe(true);
    expect(windowNamesAHandle(messages, ['forge'])).toBe(false);
    expect(windowNamesAHandle([], ['babo'])).toBe(false);
  });
});
