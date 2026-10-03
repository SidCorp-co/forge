import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { autonomousStepFor } from './autonomous-mode.js';
import {
  awaitsHuman,
  EVIDENCE_FIELDS,
  isTerminalPlacement,
  LIVE_STATUSES,
  STATUS_ASSERTIONS,
} from './status-assertions.js';

describe('STATUS_ASSERTIONS (ISS-940)', () => {
  it('covers every status the schema declares', () => {
    for (const status of issueStatuses) {
      expect(STATUS_ASSERTIONS[status], status).toBeDefined();
    }
    expect(Object.keys(STATUS_ASSERTIONS).sort()).toEqual([...issueStatuses].sort());
  });

  it('lets a status assert placement and nothing else', () => {
    for (const status of issueStatuses) {
      expect(Object.keys(STATUS_ASSERTIONS[status]).sort(), status).toEqual(['gate', 'nextActor']);
    }
  });

  it('names an agent as the next actor for exactly the statuses that dispatch', () => {
    for (const status of issueStatuses) {
      const dispatches = autonomousStepFor(status) !== null;
      expect(STATUS_ASSERTIONS[status].nextActor === 'agent', status).toBe(dispatches);
    }
  });

  it('reads `awaiting_release` as the release gate awaiting a person', () => {
    expect(STATUS_ASSERTIONS.awaiting_release).toEqual({ gate: 'release', nextActor: 'human' });
    expect(awaitsHuman('awaiting_release')).toBe(true);
    expect(awaitsHuman('open')).toBe(false);
  });

  it('reads `in_progress` as the build gate whatever step its run is on', () => {
    expect(STATUS_ASSERTIONS.in_progress).toEqual({ gate: 'build', nextActor: 'human' });
  });

  it('reads both parks as paused', () => {
    expect(STATUS_ASSERTIONS.needs_info.gate).toBe('paused');
    expect(STATUS_ASSERTIONS.on_hold.gate).toBe('paused');
  });

  it('leaves only `open` in Forge’s own hands among live statuses', () => {
    const agentOwned = LIVE_STATUSES.filter((s) => !awaitsHuman(s));
    expect(agentOwned).toEqual(['open']);
  });

  it('treats exactly `closed` and `dropped` as terminal placements', () => {
    const terminal = issueStatuses.filter(isTerminalPlacement);
    expect([...terminal].sort()).toEqual(['closed', 'dropped']);
    expect(LIVE_STATUSES).not.toContain('closed');
  });

  it('answers every evidence question off a row field, never a status', () => {
    expect(EVIDENCE_FIELDS.landed).toBe('issues.merged_at');
    expect(EVIDENCE_FIELDS.branch).toBe('issue_work_state.branch');
    expect(Object.values(EVIDENCE_FIELDS).every((f) => f.includes('.') || f.includes(' '))).toBe(
      true,
    );
  });
});
