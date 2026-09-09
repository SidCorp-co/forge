// The service layer only: what a typed master report turns INTO before it
// reaches `stampRunnerLimit`. The route suite mocks this module wholesale, so
// the reset arithmetic and the auth asymmetry are asserted here and nowhere
// else.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn(async () => [] as Array<{ id: string; projectId: string }>);
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));
vi.mock('../db/client.js', () => ({ db: { select } }));

const stampRunnerLimit = vi.fn(async () => {});
const clearRunnerLimit = vi.fn(async () => {});
vi.mock('../runners/apply-runner-limit.js', () => ({ stampRunnerLimit, clearRunnerLimit }));

const { recordMasterLimit, clearMasterLimit } = await import('./master-limit.js');

const RUNNER = { id: 'r-1', projectId: 'p-1' };
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  stampRunnerLimit.mockClear();
  clearRunnerLimit.mockClear();
  limit.mockReset().mockResolvedValue([RUNNER]);
});

const stampedUntil = () =>
  (stampRunnerLimit.mock.calls[0] as unknown as [string, string, { until: Date | null }])[2].until;

describe('recordMasterLimit', () => {
  // cm:guard `auth` MUST stamp `until: null`. The column is NULL for it by design — there is no parseable reset to wait for — and every dispatch gate excludes that reason BY NAME precisely because the time predicate would otherwise pass an auth-dead box. A reset invented here would be a self-healing window an auth limit does not have.
  it('gives an auth limit no reset even when the report carries one', async () => {
    await recordMasterLimit('dev-1', { reason: 'auth', resetsInSeconds: 900, detail: 'x' });
    expect(stampedUntil()).toBeNull();
  });

  it('turns the reported seconds into the instant core stores', async () => {
    const before = Date.now();
    await recordMasterLimit('dev-1', {
      reason: 'usage_limit',
      resetsInSeconds: 900,
      detail: 'x',
    });
    const until = stampedUntil() as Date;
    expect(until.getTime() - before).toBeGreaterThanOrEqual(900_000);
    expect(until.getTime() - before).toBeLessThan(900_000 + 60_000);
  });

  // cm:guard the unknown-reset fallback is DEFAULT_LIMIT_COOLDOWN_MS, the constant `detectRunnerLimit` already applies to a usage-limit message with no parseable reset. A second number here would make the job lane and the master lane answer one question differently.
  it('falls back to the job lane cooldown when the master cannot read a reset', async () => {
    const before = Date.now();
    await recordMasterLimit('dev-1', {
      reason: 'usage_limit',
      resetsInSeconds: null,
      detail: 'x',
    });
    const until = stampedUntil() as Date;
    expect(until.getTime() - before).toBeGreaterThanOrEqual(HOUR_MS);
    expect(until.getTime() - before).toBeLessThan(HOUR_MS + 60_000);
  });

  it('records nothing and says so when the device owns no runner', async () => {
    limit.mockResolvedValue([]);
    expect(
      await recordMasterLimit('dev-1', { reason: 'auth', resetsInSeconds: null, detail: 'x' }),
    ).toBeNull();
    expect(stampRunnerLimit).not.toHaveBeenCalled();
  });
});

describe('clearMasterLimit', () => {
  it('lifts the window through the device-wide clear', async () => {
    expect(await clearMasterLimit('dev-1')).toEqual({ runnerId: 'r-1' });
    expect(clearRunnerLimit).toHaveBeenCalledWith('r-1', 'p-1');
  });

  it('clears nothing and says so when the device owns no runner', async () => {
    limit.mockResolvedValue([]);
    expect(await clearMasterLimit('dev-1')).toBeNull();
    expect(clearRunnerLimit).not.toHaveBeenCalled();
  });
});
