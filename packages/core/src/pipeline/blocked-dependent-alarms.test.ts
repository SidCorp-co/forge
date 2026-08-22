import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
}));

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('../db/client.js', () => ({
  db: { execute: (...args: unknown[]) => dbExecute(...(args as [])) },
}));

const applyStatusTransitionMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/apply-transition.js', () => ({
  applyStatusTransition: (...args: unknown[]) => applyStatusTransitionMock(...args),
}));

const closeOpenRunForIssueMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('./runs.js', () => ({
  closeRunIfOneShot: vi.fn(),
  closeOpenRunForIssue: (...args: unknown[]) => closeOpenRunForIssueMock(...args),
}));

const { alarmUnrunnableBlockedDependents } = await import('./blocked-dependent-alarms.js');

beforeEach(() => {
  emitWedgeMock.mockClear();
  applyStatusTransitionMock.mockClear();
  closeOpenRunForIssueMock.mockClear();
  dbExecute.mockReset();
  dbExecute.mockResolvedValue([]);
});

describe('alarmUnrunnableBlockedDependents — the gate is right, the silence was not', () => {
  const draftRow = {
    job_id: '71111111-1111-4111-8111-111111111111',
    project_id: '72222222-2222-4222-8222-222222222222',
    issue_id: '73333333-3333-4333-8333-333333333333',
    blocker_seq: 51,
    blocker_title: 'a11y: /sign-up "Sign in" link fails axe',
    blocker_status: 'draft',
    blocker_count: 1,
  };

  // cm:guard alarm ONLY — never a status write and never a gate exemption. Owner decision 2026-08-14: an edge onto a draft means the draft really must come first. brand-gateway ISS-50 (3 draft blockers) and anhome ISS-313 (2) each sat queued 15-22 days with NOTHING told to anyone; that silence is the entire defect this closes.
  it('emits a wedge naming the draft blocker and writes no state', async () => {
    dbExecute.mockResolvedValueOnce([draftRow]);

    const res = await alarmUnrunnableBlockedDependents(new Date());

    expect(res.alerted).toBe(1);
    expect(applyStatusTransitionMock).not.toHaveBeenCalled();
    expect(closeOpenRunForIssueMock).not.toHaveBeenCalled();
    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(wedge.issueId).toBe(draftRow.issue_id);
    expect(wedge.summary).toContain('ISS-51');
    expect(wedge.summary).toContain('draft');
    expect(wedge.nextStep).toContain('dispatches by itself');
  });

  // cm:guard ONE notification per stuck issue, not one per edge — brand-gateway ISS-50 has three draft blockers at once, so a row-per-edge query would triple-notify about a single stuck issue and read as three problems
  it('reports the sibling blockers in one wedge rather than one wedge each', async () => {
    dbExecute.mockResolvedValueOnce([{ ...draftRow, blocker_count: 3 }]);

    const res = await alarmUnrunnableBlockedDependents(new Date());

    expect(res.alerted).toBe(1);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(wedge.summary).toContain('2 other blockers');
  });

  // cm:guard a `dropped` blocker must get its OWN guidance — "open the blocker" is wrong for one that is terminal and can never be opened, and the operator following it finds nothing to open. getcontent ISS-455 sat 53h behind dropped ISS-463 with no notification at all (measured 2026-08-22).
  it('tells the operator to expire the edge when the blocker was dropped, not to open it', async () => {
    dbExecute.mockResolvedValueOnce([{ ...draftRow, blocker_status: 'dropped' }]);

    const res = await alarmUnrunnableBlockedDependents(new Date());

    expect(res.alerted).toBe(1);
    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(wedge.title).toContain('dropped');
    expect(wedge.summary).toContain('will never merge');
    expect(wedge.reason).toBe('blocker_dropped:1');
    expect(wedge.nextStep).toContain('validUntil');
    expect(wedge.nextStep).not.toContain('Open the blocker');
  });

  it('no rows → alerted 0, nothing emitted', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const res = await alarmUnrunnableBlockedDependents(new Date());
    expect(res.alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('survives a throwing row and still reports the rest', async () => {
    dbExecute.mockResolvedValueOnce([
      draftRow,
      { ...draftRow, issue_id: '75555555-5555-4555-8555-555555555555' },
    ]);
    emitWedgeMock.mockRejectedValueOnce(new Error('notify down'));

    const res = await alarmUnrunnableBlockedDependents(new Date());

    expect(res.alerted).toBe(1);
  });

  it('returns 0 instead of throwing when the query fails', async () => {
    dbExecute.mockRejectedValueOnce(new Error('db down'));
    const res = await alarmUnrunnableBlockedDependents(new Date());
    expect(res.alerted).toBe(0);
  });
});
