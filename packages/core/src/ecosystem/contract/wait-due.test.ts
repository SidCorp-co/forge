import { describe, expect, it } from 'vitest';
import { contractWaitUnsettled } from '../../issues/index.js';
import { dueAtOf } from './wait-due.js';

const now = new Date('2026-10-05T12:00:00Z');

describe('a hand-added contract wait takes a deadline', () => {
  it('takes none when none is sent', () => {
    expect(dueAtOf(undefined, now)).toEqual({ ok: true, value: null });
  });

  it('takes a future ISO instant', () => {
    expect(dueAtOf('2026-11-01T00:00:00Z', now)).toEqual({
      ok: true,
      value: new Date('2026-11-01T00:00:00Z'),
    });
  });

  it('refuses a malformed one by name', () => {
    const r = dueAtOf('next tuesday', now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe('CONTRACT_WAIT_DUE_MALFORMED');
      expect(r.refusal.path).toBe('/dueAt');
      expect(r.refusal.detail).toContain('"next tuesday"');
    }
  });

  it('refuses a date-only or offsetless one as malformed, never guessing a zone', () => {
    expect(dueAtOf('2026-11-01', now).ok).toBe(false);
    expect(dueAtOf('2026-11-01T00:00:00', now).ok).toBe(false);
  });

  it('refuses a past one, and the present instant, by name', () => {
    for (const raw of ['2026-10-01T00:00:00Z', '2026-10-05T12:00:00Z']) {
      const r = dueAtOf(raw, now);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('CONTRACT_WAIT_DUE_PAST');
    }
  });
});

describe("the issue read names a held wait's deadline", () => {
  it('says when the wait is due, and says nothing of one where none was set', () => {
    const w = { issue: 'HOP-7', contract: 'acme/orders', minVersion: '2.0.0' };
    const [due, none] = contractWaitUnsettled([
      { ...w, dueAt: new Date('2026-11-01T00:00:00Z') },
      { ...w, dueAt: null },
    ]).refusals;
    expect(due?.detail).toContain('It is due by 2026-11-01T00:00:00.000Z.');
    expect(none?.detail).not.toContain('due by');
  });
});
