import { describe, expect, it } from 'vitest';
import { slotsOf } from './rules.js';

// epod 2026-10-06: masters/standing served slots {inUse: 3, max: 2} while the box ran no job pane:
// three in-pane builder runs the masters declared were counted against max_job_panes, which caps
// only the job panes the daemon opens for pool jobs.

describe('masters/standing slots: in use counts what max_job_panes caps', () => {
  const box = { name: 'sid-xeon-1', maxJobPanes: 2 };

  it('counts job panes in use and serves the declared runs beside them, never over the cap', () => {
    expect(slotsOf(box, { jobPanes: 0, runs: 3 })).toEqual({
      inUse: 0,
      max: 2,
      runs: 3,
      undeclared: null,
    });
  });

  it('counts every job pane the box holds', () => {
    expect(slotsOf(box, { jobPanes: 2, runs: 1 })).toMatchObject({ inUse: 2, max: 2, runs: 1 });
  });

  it('names the undeclared cap and still counts both', () => {
    const s = slotsOf({ name: 'box', maxJobPanes: null }, { jobPanes: 1, runs: 2 });
    expect(s).toMatchObject({ inUse: 1, max: null, runs: 2 });
    expect(s.undeclared?.code).toBe('MASTER_SLOTS_UNDECLARED');
  });
});
