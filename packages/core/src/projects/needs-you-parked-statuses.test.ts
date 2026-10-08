import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

import { AWAITING_INPUT_STATUSES, HUMAN_PARK_STATUSES } from '../issues/status-sets.js';
import { BLOCKED_STATUSES } from './health-aggregates.js';

describe('the statuses the Needs you tile lists a parked issue at', () => {
  it('are the statuses a person parks an issue at, so the help page names exactly these', () => {
    const listed = new Set<string>([...AWAITING_INPUT_STATUSES, ...BLOCKED_STATUSES]);
    expect([...listed].sort()).toEqual([...HUMAN_PARK_STATUSES].sort());
  });
});
