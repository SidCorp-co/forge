import type { RequirementState } from '@forge/contracts/requirements';
import { describe, expect, it, vi } from 'vitest';

// REQ-33 BC-3, BC-6: one lane rule (`ROADMAP_HORIZON_OF`) says where a requirement stands on the
// roadmap, and the status report's roadmap and the progress query both read it (the Requirements
// list's grouping reads it too: requirements-roadmap.test.tsx). Here the rule is changed once —
// agreed work moves to Now — and both follow, with nothing of their own to update.

const moved = vi.hoisted(() => ({ on: false }));
vi.mock('@forge/contracts/project-status', async (load) => {
  const real = await load<typeof import('@forge/contracts/project-status')>();
  return {
    ...real,
    ROADMAP_HORIZON_OF: new Proxy(real.ROADMAP_HORIZON_OF, {
      get: (rule, state: string) =>
        moved.on && state === 'agreed' ? 'now' : rule[state as RequirementState],
    }),
  };
});

const { onLane } = await import('../project-status/index.js');
const { progressRows } = await import('./progress-by-requirement.js');

const listed = (key: string, state: RequirementState) => ({ key, standing: { state } });
const item = (key: string, state: RequirementState) => ({
  key,
  title: key,
  standing: { state },
  delivery: { criteriaCoverage: { passing: 0, criteria: 1 } },
});
const scope = (key: string) => ({
  key,
  progress: { total: 1, shipped: 0, awaitingRelease: 0, toDo: 1 },
  delivery: null,
});

const LIST = [listed('REQ-1', 'in_delivery'), listed('REQ-2', 'agreed'), listed('REQ-3', 'draft')];
const ITEMS = [item('REQ-1', 'in_delivery'), item('REQ-2', 'agreed'), item('REQ-3', 'accepted')];
const SCOPES = ITEMS.map((i) => scope(i.key));
const rows = () => progressRows(ITEMS as never, SCOPES as never);

describe('the one lane rule', () => {
  it('puts in delivery on Now, agreed on Next and a draft on Later, and accepted work on none', () => {
    moved.on = false;
    expect(onLane(LIST, 'now').map((r) => r.key)).toEqual(['REQ-1']);
    expect(onLane(LIST, 'next').map((r) => r.key)).toEqual(['REQ-2']);
    expect(onLane(LIST, 'later').map((r) => r.key)).toEqual(['REQ-3']);
    expect(rows().map((r) => [r.key, r.lane, r.basis])).toEqual([
      ['REQ-1', 'now', 'no forecast: nothing is linked to it yet'],
      ['REQ-2', 'next', 'no forecast: nothing is linked to it yet'],
      ['REQ-3', null, 'no forecast: nothing is linked to it yet'],
    ]);
  });

  it('moves the status roadmap and the progress query together when the rule changes once', () => {
    moved.on = true;
    expect(onLane(LIST, 'now').map((r) => r.key)).toEqual(['REQ-1', 'REQ-2']);
    expect(onLane(LIST, 'next')).toEqual([]);
    expect(rows().find((r) => r.key === 'REQ-2')?.lane).toBe('now');
    moved.on = false;
  });
});
