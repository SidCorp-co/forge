import { describe, expect, it } from 'vitest';
import {
  alreadyTriagedRefusal,
  bulkMoves,
  dismissReasonRefusal,
  duplicateRefusal,
  filedIntoIssueRefusal,
  reopenRefusal,
  type TriageFacts,
  triageRefusals,
} from './rules.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const Q = '44444444-4444-4444-8444-444444444444';

const report = (over: Partial<TriageFacts> = {}): TriageFacts => ({
  id: A,
  projectId: P,
  triage: 'new',
  triagedByName: null,
  triagedAt: null,
  triageReason: null,
  duplicateOf: null,
  linkedIssueKey: null,
  feedbackKey: null,
  ...over,
});

const AT = new Date('2026-10-04T08:00:00.000Z');

describe('a report is triaged once (REQ-16 BC-3, AGENT_REPORT_ALREADY_TRIAGED)', () => {
  it('a new report may be triaged', () => {
    expect(alreadyTriagedRefusal(report())).toBeNull();
  });

  it('a second triage names who triaged it, how and when, and the way back', () => {
    const r = alreadyTriagedRefusal(
      report({ triage: 'filed', triagedByName: 'Babs', triagedAt: AT, linkedIssueKey: 'ISS-12' }),
    );
    expect(r).toMatchObject({ code: 'AGENT_REPORT_ALREADY_TRIAGED', path: '/act' });
    expect(r?.detail).toBe(
      `agent report ${A} was already filed into ISS-12 by Babs at 2026-10-04T08:00:00.000Z; reopen it ({ act: reopen }) before triaging it again.`,
    );
  });

  it('names a promotion, a dismissal with its reason, a duplicate, and a backfilled triage with no person', () => {
    expect(
      alreadyTriagedRefusal(report({ triage: 'filed', feedbackKey: 'FB-7' }))?.detail,
    ).toContain('filed as FB-7 (promoted to feedback)');
    expect(
      alreadyTriagedRefusal(
        report({ triage: 'dismissed', triageReason: 'reviewed before triage was recorded' }),
      )?.detail,
    ).toContain('dismissed ("reviewed before triage was recorded") by nobody recorded');
    expect(
      alreadyTriagedRefusal(report({ triage: 'duplicate', duplicateOf: B }))?.detail,
    ).toContain(`marked a duplicate of agent report ${B}`);
  });
});

describe('a dismissal says why (AGENT_REPORT_DISMISS_REASON_REQUIRED)', () => {
  it('no reason, an empty one and a blank one are refused at /reason', () => {
    for (const reason of [undefined, '', '   ']) {
      expect(dismissReasonRefusal(reason)).toMatchObject({
        code: 'AGENT_REPORT_DISMISS_REASON_REQUIRED',
        path: '/reason',
      });
    }
  });

  it('a one-character reason is enough', () => {
    expect(dismissReasonRefusal('x')).toBeNull();
  });
});

describe('a duplicate points at a report of the same project (AGENT_REPORT_DUPLICATE_UNKNOWN)', () => {
  it('another project, an unknown id and the report itself are each refused naming why', () => {
    const f = report();
    expect(duplicateRefusal(f, B, { id: B, projectId: Q })?.detail).toContain(
      'it was filed on another project',
    );
    expect(duplicateRefusal(f, B, null)?.detail).toContain('no such agent report exists');
    expect(duplicateRefusal(f, A, { id: A, projectId: P })?.detail).toContain(
      'a report cannot be a duplicate of itself',
    );
    expect(duplicateRefusal(f, B, null)).toMatchObject({
      code: 'AGENT_REPORT_DUPLICATE_UNKNOWN',
      path: '/duplicateOf',
    });
  });

  it('an earlier report of the same project is accepted', () => {
    expect(duplicateRefusal(report(), B, { id: B, projectId: P })).toBeNull();
  });
});

describe('reopening returns a triaged report to new (AGENT_REPORT_NOT_TRIAGED, AGENT_REPORT_PROMOTED)', () => {
  it('a new report has nothing to reopen', () => {
    expect(reopenRefusal(report())).toMatchObject({
      code: 'AGENT_REPORT_NOT_TRIAGED',
      path: '/act',
    });
  });

  it('a promoted report keeps the feedback item it became', () => {
    const r = reopenRefusal(report({ triage: 'filed', feedbackKey: 'FB-7' }));
    expect(r).toMatchObject({ code: 'AGENT_REPORT_PROMOTED', path: '/act' });
    expect(r?.detail).toContain('triage FB-7 instead');
  });

  it('a dismissed, duplicate or issue-filed report reopens', () => {
    expect(
      reopenRefusal(report({ triage: 'dismissed', triageReason: 'x', triagedAt: AT })),
    ).toBeNull();
    expect(
      reopenRefusal(report({ triage: 'duplicate', duplicateOf: B, triagedAt: AT })),
    ).toBeNull();
    expect(
      reopenRefusal(report({ triage: 'filed', linkedIssueKey: 'ISS-3', triagedAt: AT })),
    ).toBeNull();
  });
});

describe('one act reads every rule before anything is written', () => {
  it('a dismissal of a triaged report with no reason answers both refusals', () => {
    const codes = triageRefusals(
      report({ triage: 'filed', linkedIssueKey: 'ISS-1' }),
      { act: 'dismiss' },
      null,
    ).map((r) => r.code);
    expect(codes).toEqual(['AGENT_REPORT_ALREADY_TRIAGED', 'AGENT_REPORT_DISMISS_REASON_REQUIRED']);
  });

  it('a bulk act moves only the reports its act applies to', () => {
    expect(bulkMoves(report(), { act: 'dismiss', reason: 'x' })).toBe(true);
    expect(bulkMoves(report({ triage: 'dismissed' }), { act: 'dismiss', reason: 'x' })).toBe(false);
    expect(bulkMoves(report({ triage: 'dismissed' }), { act: 'reopen' })).toBe(true);
    expect(bulkMoves(report({ triage: 'filed', feedbackKey: 'FB-1' }), { act: 'reopen' })).toBe(
      false,
    );
    expect(bulkMoves(report(), { act: 'duplicate', duplicateOf: A })).toBe(false);
  });
});

describe('the issue a report was filed into is not deleted under it (AGENT_REPORT_FILED_INTO_ISSUE)', () => {
  it('names the issue, every report it carries, and the way out', () => {
    const r = filedIntoIssueRefusal('ISS-12', [A, B]);
    expect(r.code).toBe('AGENT_REPORT_FILED_INTO_ISSUE');
    expect(r.detail).toBe(
      `ISS-12 carries 2 filed agent report(s) (${A}, ${B}); deleting it would leave each with no target. Reopen them ({ act: reopen }) first.`,
    );
  });
});
