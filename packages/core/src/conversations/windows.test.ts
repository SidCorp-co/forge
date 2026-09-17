/**
 * ISS-1086 — the hold in force is the deployment's number or today's constant, and
 * nothing else: the two criteria this covers (19, 22) are the two ways the env
 * wiring can fail apart from the eligibility tests, which pass a hold explicitly.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: {} }));
vi.mock('../db/client.js', () => ({ db: {} }));

const { resolveHoldMs, WINDOW_HOLD_MS, WINDOW_SETTLE_MS } = await import('./windows.js');

describe('the hold a claim uses', () => {
  it('is 15000 with CONVERSATION_WINDOW_HOLD_MS unset (criterion 19)', () => {
    expect(resolveHoldMs(undefined)).toBe(15_000);
    expect(WINDOW_HOLD_MS).toBe(15_000);
  });

  it('is the override where one is set (criterion 22)', () => {
    expect(resolveHoldMs(7000)).toBe(7000);
  });

  // cm:guard the hold is a bound BESIDE the settle, never under it: a hold shorter than the settle would cut every window at the hold and the settle clock would never decide anything, which is the convention on `extended_at` silently retired.
  it('sits above the settle', () => {
    expect(WINDOW_HOLD_MS).toBeGreaterThan(WINDOW_SETTLE_MS);
  });
});
