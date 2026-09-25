/**
 * ISS-1042 criteria 26–28 — reading a run's method, and refusing a run that
 * has none or the wrong one.
 *
 * Unit, because the whole decision is over one value: what the run's metadata
 * holds against what its job names. The announcement's own write is SQL and is
 * proved next door in `tests/integration/release-ledger-e2e.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { assertMethodFor, MethodMismatchError, MethodNotAnnouncedError, readMethod } = await import(
  './method.js'
);

const where = { projectId: 'proj-3', runId: 'run-5' };

const announced = (over: Record<string, unknown> = {}) => ({
  method: { skill: 'release-flow', loaded: true, detail: null, announcedAt: 'now', ...over },
});

describe('readMethod', () => {
  it('reads an announcement off the run metadata', () => {
    expect(readMethod(announced())).toMatchObject({ skill: 'release-flow', loaded: true });
  });

  it('is null for a run that announced nothing', () => {
    expect(readMethod({ source: 'release-batch' })).toBeNull();
    expect(readMethod(null)).toBeNull();
  });

  it('is null for a method that names no skill', () => {
    expect(readMethod({ method: {} })).toBeNull();
    expect(readMethod({ method: { skill: '' } })).toBeNull();
    expect(readMethod({ method: 'release-flow' })).toBeNull();
  });

  it('reads a missing or non-boolean `loaded` as not loaded', () => {
    expect(readMethod({ method: { skill: 'x' } })?.loaded).toBe(false);
    expect(readMethod({ method: { skill: 'x', loaded: 'yes' } })?.loaded).toBe(false);
  });
});

describe('assertMethodFor', () => {
  it('passes a run that announced the skill its job names', () => {
    expect(() => assertMethodFor(readMethod(announced()), 'release-flow', where)).not.toThrow();
  });

  it('refuses a run that announced nothing, naming the skill it owes', () => {
    try {
      assertMethodFor(null, 'release-flow', where);
      expect.unreachable('a run with no announcement must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(MethodNotAnnouncedError);
      expect(err).toMatchObject({ expected: 'release-flow', where });
    }
  });

  it('refuses a run whose announcement names another skill, naming both', () => {
    try {
      assertMethodFor(readMethod(announced({ skill: 'issue-flow' })), 'release-flow', where);
      expect.unreachable('a run working from another method must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(MethodMismatchError);
      expect(err).toMatchObject({ announced: 'issue-flow', expected: 'release-flow' });
    }
  });

  it('admits a run that announced it could NOT load its method, which is the priced amnesty', () => {
    expect(() =>
      assertMethodFor(readMethod(announced({ loaded: false })), 'release-flow', where),
    ).not.toThrow();
  });
});
