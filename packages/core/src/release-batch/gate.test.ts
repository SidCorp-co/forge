// The gate answer is read by two very different callers: the batch service,
// where `null` only hides an action, and the close rewrite, where a non-null
// answer BLOCKS an autonomous agent from ever closing an issue. These tests
// pin the asymmetry that follows from that.

import { describe, expect, it } from 'vitest';
import { resolveReleaseGateStatus } from './gate.js';

describe('resolveReleaseGateStatus', () => {
  // cm:guard `{ enabled: true }` no longer spells staged — since 2026-09-02 an absent `mode` resolves autonomous, and only `null` (an unreadable config) still falls back to staged. The title says "by default"; the default it now means is the one written here.
  it('gives a staged project a gate, and an unreadable config the same', () => {
    expect(resolveReleaseGateStatus(null)).toBe('tested');
    expect(resolveReleaseGateStatus({ enabled: true, mode: 'staged' })).toBe('tested');
    expect(
      resolveReleaseGateStatus({
        enabled: true,
        mode: 'staged',
        states: { tested: { mode: 'manual' } },
      }),
    ).toBe('tested');
  });

  it('has no gate where the project turned the park off', () => {
    expect(resolveReleaseGateStatus({ states: { tested: { enabled: false } } })).toBeNull();
    expect(resolveReleaseGateStatus({ states: { tested: { mode: 'auto' } } })).toBeNull();
  });

  // cm:guard the whole rollout rests on this line: an autonomous project that never asked for a release path must keep closing its own issues, because nothing exists to release them. Defaulting the gate on would park every issue of every such project the day this ships.
  it('refuses to default a gate on for an autonomous project', () => {
    expect(resolveReleaseGateStatus({ mode: 'autonomous' })).toBeNull();
    expect(resolveReleaseGateStatus({ mode: 'autonomous', states: {} })).toBeNull();
    expect(
      resolveReleaseGateStatus({ mode: 'autonomous', states: { tested: { enabled: true } } }),
    ).toBeNull();
  });

  it('gives an autonomous project the gate it declared', () => {
    expect(
      resolveReleaseGateStatus({
        mode: 'autonomous',
        states: { tested: { mode: 'manual', enabled: true } },
      }),
    ).toBe('tested');
  });
});
