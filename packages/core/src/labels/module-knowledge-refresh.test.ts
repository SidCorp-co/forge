import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { moduleNodeBodyHash, nextModuleFlowRecord } = await import('./module-knowledge-refresh.js');

/**
 * ISS-948 — `nextModuleFlowRecord` carries the whole idempotency and self-clearing rule of the
 * flow half, so it is tested alone. Each case is one the loop's behaviour depends on: a second
 * landing of the same issue must not move the record, and a landing after the flow was redrawn
 * must.
 */
describe('nextModuleFlowRecord (ISS-948)', () => {
  const t1 = new Date('2026-09-07T10:00:00.000Z');
  const t2 = new Date('2026-09-07T11:00:00.000Z');
  const hashA = moduleNodeBodyHash('flow A');
  const hashB = moduleNodeBodyHash('flow B');

  it('arms the record on the first landing against a node nothing has marked', () => {
    expect(nextModuleFlowRecord(null, hashA, 'issue-1', t1)).toEqual({
      staleSince: t1.toISOString(),
      staleByIssueId: 'issue-1',
      bodyHash: hashA,
    });
  });

  it('leaves the record untouched when the same issue lands again on an unchanged body', () => {
    const first = nextModuleFlowRecord(null, hashA, 'issue-1', t1);
    expect(nextModuleFlowRecord(first, hashA, 'issue-1', t2)).toBe(first);
  });

  it('keeps the issue that first got there when a second issue lands on an unchanged body', () => {
    const first = nextModuleFlowRecord(null, hashA, 'issue-1', t1);
    const second = nextModuleFlowRecord(first, hashA, 'issue-2', t2);
    expect(second.staleByIssueId).toBe('issue-1');
    expect(second.staleSince).toBe(t1.toISOString());
  });

  it('re-arms against the new body once the flow has been redrawn', () => {
    const first = nextModuleFlowRecord(null, hashA, 'issue-1', t1);
    expect(nextModuleFlowRecord(first, hashB, 'issue-2', t2)).toEqual({
      staleSince: t2.toISOString(),
      staleByIssueId: 'issue-2',
      bodyHash: hashB,
    });
  });

  it('hashes a body to something a body one character apart does not share', () => {
    expect(moduleNodeBodyHash('flow A')).toBe(hashA);
    expect(moduleNodeBodyHash('flow A ')).not.toBe(hashA);
  });
});
