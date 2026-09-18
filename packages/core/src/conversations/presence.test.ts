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
  applyRoomPresence,
  foldAnswerInGroup,
  foldPresence,
  heartbeatOf,
  namesHandle,
  PRESENCE_BOUNDS,
  PRESENCE_DEFAULTS,
  PresenceValidationError,
  replyTargetsOf,
  validatePresence,
  validateRoomPresence,
  windowAddressesAHandle,
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

describe('a room’s own presence (ISS-1087)', () => {
  const fold = foldPresence([]);

  it('applies each key the room set and leaves the fold for the rest (criterion 6)', () => {
    const out = applyRoomPresence(fold, { backoffAfter: 1, answerInGroup: 'mention' });
    expect(out.backoffAfter).toBe(1);
    expect(out.answerInGroup).toBe('mention');
    expect(out.dormantMs).toBe(fold.dormantMs);
    expect(out.loopBounceMs).toBe(fold.loopBounceMs);
    expect(out.loopLimit).toBe(fold.loopLimit);
  });

  it('changes nothing for a room that set nothing', () => {
    expect(applyRoomPresence(fold, null)).toEqual(fold);
    expect(applyRoomPresence(fold, {})).toEqual(fold);
  });

  // cm:guard the refusal NAMES heartbeat as a handle's own and lists what a room takes, because the person fixing the payload reads the error and not this file (criterion 3).
  it('refuses heartbeat by name, listing the five room keys (criterion 3)', () => {
    expect(() => validateRoomPresence({ heartbeat: { enabled: true } })).toThrow(
      /`heartbeat` is a handle's own and is not set on a room; a room takes only: dormantMs, backoffAfter, loopBounceMs, loopLimit, answerInGroup/,
    );
  });

  it('refuses an out-of-bounds value naming the key and the bounds (criterion 4)', () => {
    expect(() => validateRoomPresence({ backoffAfter: 21 })).toThrow(
      /presence.backoffAfter must be between 1 and 20/,
    );
  });

  it('accepts tool as a room mode and as a self mode (criterion 15)', () => {
    expect(validateRoomPresence({ answerInGroup: 'tool' })).toEqual({ answerInGroup: 'tool' });
    expect(validatePresence({ answerInGroup: 'tool' })).toEqual({ answerInGroup: 'tool' });
  });

  it('reads nothing off the room for the heartbeat (criterion 7)', () => {
    expect(heartbeatOf({ heartbeat: { enabled: true } })).toEqual({
      enabled: true,
      intervalMs: PRESENCE_DEFAULTS.heartbeatIntervalMs,
    });
  });
});

describe('answerInGroup with three modes (ISS-1087)', () => {
  it('folds mention over tool over window (criterion 16)', () => {
    expect(foldAnswerInGroup(['mention', 'tool'])).toBe('mention');
    expect(foldAnswerInGroup(['tool', 'window'])).toBe('tool');
    expect(foldAnswerInGroup(['tool', undefined])).toBe('tool');
    expect(foldAnswerInGroup(['window', undefined])).toBe('window');
    expect(foldPresence([{ answerInGroup: 'tool' }, {}]).answerInGroup).toBe('tool');
  });
});

describe('a window that replies to the handle (ISS-1087)', () => {
  const handles = ['babo'];
  const reply = (replyToExternalId: string | null, content = 'still wrong') => ({
    content,
    replyToExternalId,
  });

  it('is addressed when a reply target is one the handle sent (criterion 13)', () => {
    expect(windowAddressesAHandle([reply('rc-bot-1')], handles, new Set(['rc-bot-1']))).toBe(true);
  });

  it('is not addressed when the reply target is a person’s message (criterion 14)', () => {
    expect(windowAddressesAHandle([reply('rc-alice-1')], handles, new Set(['rc-bot-1']))).toBe(
      false,
    );
    expect(windowAddressesAHandle([reply(null)], handles, new Set(['rc-bot-1']))).toBe(false);
  });

  it('is still addressed by name alone', () => {
    expect(windowAddressesAHandle([reply(null, '@babo look')], handles, new Set())).toBe(true);
  });

  it('collects the distinct reply targets for the store to resolve', () => {
    expect(replyTargetsOf([reply('a'), reply('a'), reply(null), reply('b')])).toEqual(['a', 'b']);
  });
});
