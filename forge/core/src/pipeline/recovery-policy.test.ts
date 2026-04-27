import { describe, expect, it } from 'vitest';
import { DEFAULT_RECOVERY_CONFIG, decideRecovery } from './recovery-policy.js';

const fresh = {
  recoveryAttempts: 0,
  lastRecoveryAt: null,
  recoveryWindowStartedAt: null,
};

const inWindow = (attempts: number) => ({
  recoveryAttempts: attempts,
  lastRecoveryAt: new Date('2026-04-27T10:00:00Z'),
  recoveryWindowStartedAt: new Date('2026-04-27T08:00:00Z'),
});

const expiredWindow = (attempts: number) => ({
  recoveryAttempts: attempts,
  lastRecoveryAt: new Date('2026-04-26T08:00:00Z'),
  recoveryWindowStartedAt: new Date('2026-04-26T08:00:00Z'), // 26h+ ago
});

const NOW = new Date('2026-04-27T11:00:00Z');

describe('recovery-policy.decideRecovery', () => {
  it('skips when failureKind is null (no terminal failure to act on)', () => {
    const r = decideRecovery({ issue: fresh, failureKind: null, now: NOW });
    expect(r.decide).toBe('skip');
  });

  it('escalates immediately on permanent failure regardless of attempts', () => {
    const r = decideRecovery({ issue: fresh, failureKind: 'permanent', now: NOW });
    expect(r.decide).toBe('escalate');
    if (r.decide === 'escalate') {
      expect(r.reason).toContain('permanent');
    }
  });

  it('escalates permanent even with a healthy recovery budget remaining', () => {
    const r = decideRecovery({ issue: inWindow(1), failureKind: 'permanent', now: NOW });
    expect(r.decide).toBe('escalate');
  });

  it('recovers transient on first failure (fresh issue)', () => {
    const r = decideRecovery({ issue: fresh, failureKind: 'transient', now: NOW });
    expect(r.decide).toBe('recover');
    if (r.decide === 'recover') {
      expect(r.nextAttempt).toBe(1);
      expect(r.resetWindow).toBe(false); // first recovery starts the window
    }
  });

  it('keeps recovering transient up to its kind cap (5)', () => {
    for (let n = 0; n < DEFAULT_RECOVERY_CONFIG.byKind.transient!; n++) {
      const r = decideRecovery({ issue: inWindow(n), failureKind: 'transient', now: NOW });
      expect(r.decide).toBe('recover');
    }
  });

  it('escalates transient once cap is hit', () => {
    const cap = DEFAULT_RECOVERY_CONFIG.byKind.transient!;
    const r = decideRecovery({ issue: inWindow(cap), failureKind: 'transient', now: NOW });
    expect(r.decide).toBe('escalate');
  });

  it('uses unknown cap (2) — stricter than transient', () => {
    expect(decideRecovery({ issue: inWindow(0), failureKind: 'unknown', now: NOW }).decide).toBe(
      'recover',
    );
    expect(decideRecovery({ issue: inWindow(1), failureKind: 'unknown', now: NOW }).decide).toBe(
      'recover',
    );
    expect(decideRecovery({ issue: inWindow(2), failureKind: 'unknown', now: NOW }).decide).toBe(
      'escalate',
    );
  });

  it('resets the window when 24h+ have elapsed since recoveryWindowStartedAt', () => {
    const r = decideRecovery({ issue: expiredWindow(99), failureKind: 'transient', now: NOW });
    expect(r.decide).toBe('recover');
    if (r.decide === 'recover') {
      expect(r.resetWindow).toBe(true);
      expect(r.nextAttempt).toBe(1);
    }
  });

  it('window reset still escalates permanent (kind always wins over budget)', () => {
    const r = decideRecovery({ issue: expiredWindow(0), failureKind: 'permanent', now: NOW });
    expect(r.decide).toBe('escalate');
  });

  it('respects per-project config override that TIGHTENS the cap', () => {
    // byKind defaults are { transient:5, unknown:2, permanent:0 } and the
    // policy uses byKind first, falling back to maxAttempts only when a
    // kind has no entry. To meaningfully tighten unknown we have to set
    // it explicitly — overriding maxAttempts alone wouldn't help because
    // byKind.unknown=2 already wins.
    const tightConfig = { maxAttempts: 1, windowHours: 1, byKind: { unknown: 1 as 1 } };
    const recent = {
      recoveryAttempts: 1,
      lastRecoveryAt: new Date(NOW.getTime() - 30 * 60_000),
      recoveryWindowStartedAt: new Date(NOW.getTime() - 30 * 60_000),
    };
    const r = decideRecovery({
      issue: recent,
      failureKind: 'unknown',
      config: tightConfig,
      now: NOW,
    });
    expect(r.decide).toBe('escalate');
  });

  it('respects per-project config override that LOOSENS the cap', () => {
    const generous = { maxAttempts: 10, windowHours: 24, byKind: { transient: 20 } };
    const r = decideRecovery({
      issue: inWindow(15),
      failureKind: 'transient',
      config: generous,
      now: NOW,
    });
    expect(r.decide).toBe('recover');
  });

  it('treats permanent as 0 cap regardless of byKind override', () => {
    const generous = { maxAttempts: 10, byKind: { permanent: 5 as 5 } };
    // We document this invariant: permanent is always escalate, even if
    // someone tries to grant it a budget via byKind. Caller's intent of
    // "I want 5 retries on filter blocks" would silently waste API
    // credits — better to refuse it.
    // (Actual implementation: permanent kind short-circuits even when cap > 0.)
    const r = decideRecovery({
      issue: fresh,
      failureKind: 'permanent',
      config: generous,
      now: NOW,
    });
    expect(r.decide).toBe('escalate');
  });
});
