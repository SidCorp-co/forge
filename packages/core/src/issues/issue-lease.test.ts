/**
 * ISS-1109 — what a refused box is actually told.
 *
 * The refusal IS the deliverable here. A box told only that the open failed
 * retries against the same holder until the lease lapses; a box told which
 * device holds the issue and since when has an act to take. The two cases are
 * different acts — close your own run session, or go and ask another box — so
 * one sentence for both hides which of the two it is.
 */

import { describe, expect, it } from 'vitest';
import { IssueLeaseHeldError, type IssueLeaseHolder } from './issue-lease.js';

const ASKING = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function holder(overrides: Partial<IssueLeaseHolder> = {}): IssueLeaseHolder {
  return {
    issueKey: 'ISS-357',
    deviceId: OTHER,
    sessionId: 'sess-9',
    runId: 'run-9',
    acquiredAt: '2026-09-20T09:37:00.000Z',
    ...overrides,
  };
}

describe('the refusal a held lease produces', () => {
  it('names the issue key', () => {
    const err = new IssueLeaseHeldError([holder()], ASKING);
    expect(err.message).toContain('ISS-357');
  });

  it('names the device holding it', () => {
    const err = new IssueLeaseHeldError([holder()], ASKING);
    expect(err.message).toContain(OTHER);
  });

  it('names the run session holding it', () => {
    const err = new IssueLeaseHeldError([holder()], ASKING);
    expect(err.message).toContain('sess-9');
  });

  it('names when the lease was taken', () => {
    const err = new IssueLeaseHeldError([holder()], ASKING);
    expect(
      err.message,
      'an operator who cannot tell a lease taken four hours ago from one taken four seconds ago cannot tell a wedge from a race',
    ).toContain('2026-09-20T09:37:00.000Z');
  });

  it('says every key it refused over, not only the first', () => {
    const err = new IssueLeaseHeldError(
      [holder({ issueKey: 'ISS-357' }), holder({ issueKey: 'ISS-358' })],
      ASKING,
    );
    expect(err.message).toContain('ISS-358');
  });

  it('tells a box refused by its own earlier run that it is its own', () => {
    const err = new IssueLeaseHeldError([holder({ deviceId: ASKING })], ASKING);
    expect(err.message).toContain('this same box');
  });

  it('tells a box refused by a stranger that it is a stranger', () => {
    const err = new IssueLeaseHeldError([holder()], ASKING);
    expect(err.message).toContain('another box');
  });

  it('gives a box refused by its own run a different act from one refused by a stranger', () => {
    const own = new IssueLeaseHeldError([holder({ deviceId: ASKING })], ASKING).message;
    const stranger = new IssueLeaseHeldError([holder()], ASKING).message;
    expect(
      own,
      'the way out of one is closing your own session and the way out of the other is working something else, and a shared sentence sends a box down the wrong one',
    ).not.toEqual(stranger);
  });

  it('carries a machine-readable code beside the prose', () => {
    const err = new IssueLeaseHeldError([holder()], ASKING);
    expect(err.code).toBe('ISSUE_LEASE_HELD');
  });

  it('carries the holders themselves, so a route can send them structured', () => {
    const err = new IssueLeaseHeldError([holder()], ASKING);
    expect(err.holders.map((h) => h.issueKey)).toEqual(['ISS-357']);
  });
});
