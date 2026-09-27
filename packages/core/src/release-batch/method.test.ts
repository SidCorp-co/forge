/**
 * ISS-1042 criteria 26–28, as ISS-1276 left them: reading a run's method, which is a record and no
 * longer a gate. `assertMethodFor` refused a run that announced none and one whose announcement
 * named another skill, which made `release-flow` a precondition for releasing at all.
 *
 * Unit, because the whole decision is over one value. The announcement's own write is SQL and is
 * proved next door in `tests/integration/release-ledger-e2e.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const methodModule = await import('./method.js');
const { readMethod } = methodModule;

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

describe('the method is a record and not a gate (ISS-1276)', () => {
  it('exports no assertion a finish could refuse on', () => {
    expect(methodModule).not.toHaveProperty('assertMethodFor');
    expect(methodModule).not.toHaveProperty('MethodNotAnnouncedError');
    expect(methodModule).not.toHaveProperty('MethodMismatchError');
  });

  it('still reads back an announcement naming a skill other than release-flow', () => {
    expect(readMethod(announced({ skill: 'issue-flow' }))).toMatchObject({
      skill: 'issue-flow',
      loaded: true,
    });
  });

  it('still reads back an announcement saying the method would not load', () => {
    expect(readMethod(announced({ loaded: false, detail: 'no plugin on this box' }))).toMatchObject(
      {
        loaded: false,
        detail: 'no plugin on this box',
      },
    );
  });
});
