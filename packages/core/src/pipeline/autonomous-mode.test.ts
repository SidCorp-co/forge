import { describe, expect, it } from 'vitest';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import {
  AUTONOMOUS_DRIVER_STATUSES,
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_INFLIGHT_STATUSES,
  AUTONOMOUS_QUESTION_STATUS,
  BACKLOG_ADMISSIBLE_STATUSES,
} from './autonomous-mode.js';

describe('AUTONOMOUS_INFLIGHT_STATUSES (ISS-890)', () => {
  it('holds in_progress — the status a stopped driver leaves its issue at', () => {
    expect(AUTONOMOUS_INFLIGHT_STATUSES).toContain('in_progress');
  });

  it('excludes the entry status, where a job IS dispatched', () => {
    expect(AUTONOMOUS_INFLIGHT_STATUSES).not.toContain(AUTONOMOUS_ENTRY_STATUS);
  });

  it('excludes the park, where a human is legitimately being waited on', () => {
    expect(AUTONOMOUS_INFLIGHT_STATUSES).not.toContain(AUTONOMOUS_QUESTION_STATUS);
  });

  it('excludes the terminal statuses, whose runs are already closing', () => {
    for (const s of ISSUE_TERMINAL_STATUSES) {
      expect(AUTONOMOUS_INFLIGHT_STATUSES).not.toContain(s);
    }
  });

  it('never names a status the driver cannot write', () => {
    for (const s of AUTONOMOUS_INFLIGHT_STATUSES) {
      expect(AUTONOMOUS_DRIVER_STATUSES).toContain(s);
    }
  });

  it('partitions the driver statuses exactly — an unclassified one lands here, never nowhere', () => {
    const classified = new Set([
      AUTONOMOUS_ENTRY_STATUS,
      AUTONOMOUS_QUESTION_STATUS,
      ...ISSUE_TERMINAL_STATUSES,
      ...AUTONOMOUS_INFLIGHT_STATUSES,
    ]);
    expect([...AUTONOMOUS_DRIVER_STATUSES].sort()).toEqual([...classified].sort());
  });
});

describe('BACKLOG_ADMISSIBLE_STATUSES and the two revived rungs (ISS-976)', () => {
  it('admits both revived rungs, and neither is a driver status', () => {
    for (const rung of ['confirmed', 'approved'] as const) {
      expect(BACKLOG_ADMISSIBLE_STATUSES, `${rung} admissible`).toContain(rung);
      expect(AUTONOMOUS_DRIVER_STATUSES, `${rung} driver status`).not.toContain(rung);
    }
  });
});
