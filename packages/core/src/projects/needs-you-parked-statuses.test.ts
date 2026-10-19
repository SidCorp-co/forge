import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

import { HUMAN_PARK_STATUSES } from '../issues/status-sets.js';
import { BLOCKED_STATUSES } from './health-aggregates.js';

describe('the statuses the health row lists a parked issue at', () => {
  it('are every status a person parks an issue at, whoever owns the issue', () => {
    // The attention response lists only the viewer's own; the parked list holds everyone else's.
    expect([...BLOCKED_STATUSES].sort()).toEqual([...HUMAN_PARK_STATUSES].sort());
  });
});
