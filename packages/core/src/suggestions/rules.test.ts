import { SUGGESTION_MAX_OPEN_PER_TARGET as MAX_OPEN_PER_TARGET } from '@forge/contracts/suggestions';
import { describe, expect, it } from 'vitest';
import { type PersonActFacts, personActRefusal } from '../lib/person-act.js';
import {
  baseStaleRefusal,
  blockerRefusal,
  breakdownBuilds,
  breakdownFaults,
  breakdownOpenRefusal,
  breakdownProposerRefusal,
  decidedRefusal,
  duplicateRefusal,
  fingerprintOf,
  payloadRefusal,
  producerRefusal,
  queueFullRefusal,
  rejectReasonRefusal,
  reviseProducerRefusal,
  unchangedRevisionRefusal,
  withdrawRefusal,
} from './rules.js';

const person: PersonActFacts = { userId: 'u1', agency: 'human', role: 'member' };

describe('suggestion-lifecycle guards', () => {
  it('start → proposed: a payload that does not parse for its kind is SUGGESTION_PAYLOAD_INVALID', () => {
    expect(
      payloadRefusal('revision_diff', 'requirement', { reason: 'r', criteria: [] }),
    ).toBeNull();
    expect(payloadRefusal('revision_diff', 'requirement', { criteria: [] })?.code).toBe(
      'SUGGESTION_PAYLOAD_INVALID',
    );
  });

  it('start → proposed: a kind on a target it does not take is SUGGESTION_TARGET_INVALID', () => {
    expect(payloadRefusal('revision_diff', 'issue', { reason: 'r', criteria: [] })?.code).toBe(
      'SUGGESTION_TARGET_INVALID',
    );
  });

  it('start → proposed and proposed → accepted: a base that is not the head is SUGGESTION_BASE_STALE naming both', () => {
    expect(baseStaleRefusal(3, 3)).toBeNull();
    const stale = baseStaleRefusal(3, 4);
    expect(stale?.code).toBe('SUGGESTION_BASE_STALE');
    expect(stale?.detail).toContain('revision 3');
    expect(stale?.detail).toContain('revision 4');
  });

  it('start → proposed: an open twin is SUGGESTION_DUPLICATE, and key order does not make a new one', () => {
    expect(fingerprintOf('duplicate', { a: 1, b: 2 })).toBe(
      fingerprintOf('duplicate', { b: 2, a: 1 }),
    );
    expect(duplicateRefusal(null)).toBeNull();
    expect(duplicateRefusal('s1')?.code).toBe('SUGGESTION_DUPLICATE');
  });

  it('proposed: the 6th open on one target is SUGGESTION_QUEUE_FULL', () => {
    expect(queueFullRefusal(MAX_OPEN_PER_TARGET - 1)).toBeNull();
    expect(queueFullRefusal(MAX_OPEN_PER_TARGET)?.code).toBe('SUGGESTION_QUEUE_FULL');
  });

  it('proposed → accepted: an agent or a non-member is SUGGESTION_ACCEPT_FORBIDDEN, by the shared person-act check', () => {
    const accept = (f: PersonActFacts) =>
      personActRefusal(f, 'p', 'accepting a suggestion', 'SUGGESTION_ACCEPT_FORBIDDEN')?.code ??
      null;
    expect(accept(person)).toBeNull();
    expect(accept({ ...person, agency: 'agent' })).toBe('SUGGESTION_ACCEPT_FORBIDDEN');
    expect(accept({ ...person, role: 'viewer' })).toBe('SUGGESTION_ACCEPT_FORBIDDEN');
  });

  it('proposed → accepted: the producer is SUGGESTION_ACCEPT_FORBIDDEN', () => {
    expect(producerRefusal('u1', 'p1')).toBeNull();
    expect(producerRefusal('u1', null)).toBeNull();
    expect(producerRefusal('u1', 'u1')?.code).toBe('SUGGESTION_ACCEPT_FORBIDDEN');
  });

  it('proposed → rejected: a rejection without a reason is SUGGESTION_REJECT_REASON_REQUIRED', () => {
    expect(rejectReasonRefusal('not what the BA meant')).toBeNull();
    expect(rejectReasonRefusal('  ')?.code).toBe('SUGGESTION_REJECT_REASON_REQUIRED');
  });

  it('after a final state: accept, reject or withdraw is SUGGESTION_DECIDED naming the status', () => {
    expect(decidedRefusal('proposed')).toBeNull();
    const decided = decidedRefusal('stale');
    expect(decided?.code).toBe('SUGGESTION_DECIDED');
    expect(decided?.detail).toContain('stale');
  });

  it('proposed → withdrawn: only the producer withdraws (SUGGESTION_WITHDRAW_FORBIDDEN)', () => {
    expect(withdrawRefusal('p1', 'p1')).toBeNull();
    expect(withdrawRefusal('u1', 'p1')?.code).toBe('SUGGESTION_WITHDRAW_FORBIDDEN');
  });
});

describe('a breakdown, checked at propose and again at accept', () => {
  const codes = new Map([
    ['BC-1', 'w1'],
    ['BC-2', 'w2'],
  ]);

  it('traces to live BCs and blockers among the proposed issues pass', () => {
    const p = {
      issues: [
        { title: 'A', complexity: 's' as const, criteria: [{ body: 'a', tracesTo: 'BC-1' }] },
        {
          title: 'B',
          complexity: 's' as const,
          criteria: [{ body: 'b', tracesTo: 'BC-1' }],
          blockedBy: [0],
        },
      ],
    };
    expect(breakdownFaults(p, codes, 1)).toEqual([]);
  });

  it('a trace to a BC the base revision does not hold is SUGGESTION_PAYLOAD_INVALID at its path', () => {
    const faults = breakdownFaults(
      {
        issues: [
          { title: 'A', complexity: 's' as const, criteria: [{ body: 'a', tracesTo: 'BC-9' }] },
        ],
      },
      codes,
      3,
    );
    expect(faults).toEqual([
      expect.objectContaining({
        code: 'SUGGESTION_PAYLOAD_INVALID',
        path: '/payload/issues/0/criteria/0/tracesTo',
      }),
    ]);
    expect(faults[0]?.detail).toContain('revision 3');
  });

  it('a blocker index outside the payload, or the issue itself, is named', () => {
    const faults = breakdownFaults(
      {
        issues: [
          {
            title: 'A',
            complexity: 's' as const,
            criteria: [{ body: 'b', tracesTo: 'BC-1' }],
            blockedBy: [0],
          },
          {
            title: 'B',
            complexity: 's' as const,
            criteria: [{ body: 'b', tracesTo: 'BC-1' }],
            blockedBy: [5],
          },
        ],
      },
      codes,
      1,
    );
    expect(faults.map((f) => f.path)).toEqual([
      '/payload/issues/0/blockedBy/0',
      '/payload/issues/1/blockedBy/0',
    ]);
  });

  it('blockers that close a cycle are refused at the entry that closes it', () => {
    const faults = breakdownFaults(
      {
        issues: [
          {
            title: 'A',
            complexity: 's' as const,
            criteria: [{ body: 'b', tracesTo: 'BC-1' }],
            blockedBy: [1],
          },
          {
            title: 'B',
            complexity: 's' as const,
            criteria: [{ body: 'b', tracesTo: 'BC-1' }],
            blockedBy: [0],
          },
        ],
      },
      codes,
      1,
    );
    expect(faults[0]).toMatchObject({ path: '/payload/issues/1/blockedBy/0' });
  });
});

describe('a breakdown blocker named by key or uuid (ISS-89)', () => {
  const live = { key: 'ISS-9', projectId: 'p1', status: 'open', archived: false };
  const at = '/payload/issues/0/blockedBy/0';

  it('a live issue of this project passes, and a string index never reads as a payload index', () => {
    expect(blockerRefusal(at, 'ISS-9', 'p1', live)).toBeNull();
    expect(
      breakdownFaults(
        {
          issues: [
            {
              title: 'A',
              complexity: 's' as const,
              criteria: [{ body: 'b', tracesTo: 'BC-1' }],
              blockedBy: ['ISS-9'],
            },
          ],
        },
        new Map([['BC-1', 'w1']]),
        1,
      ),
    ).toEqual([]);
  });

  it('nothing answering, another project’s issue, or an unreadable key is SUGGESTION_BLOCKER_UNKNOWN', () => {
    expect(blockerRefusal(at, 'ISS-404', 'p1', null)?.code).toBe('SUGGESTION_BLOCKER_UNKNOWN');
    const foreign = blockerRefusal(at, 'u-1', 'p1', { ...live, projectId: 'p2' });
    expect(foreign?.code).toBe('SUGGESTION_BLOCKER_UNKNOWN');
    expect(foreign?.detail).toContain('another project');
    expect(blockerRefusal(at, 'nope', 'p1', null, 'not a key')?.detail).toContain('not a key');
  });

  it('a closed, dropped or archived issue is SUGGESTION_BLOCKER_TERMINAL', () => {
    for (const found of [
      { ...live, status: 'closed' },
      { ...live, status: 'dropped' },
      { ...live, archived: true },
    ]) {
      expect(blockerRefusal(at, 'ISS-9', 'p1', found)).toMatchObject({
        code: 'SUGGESTION_BLOCKER_TERMINAL',
        path: at,
      });
    }
  });
});

describe('a reviewer revises a proposed suggestion (ISS-117, FB-62)', () => {
  it('an agent or a non-member is SUGGESTION_REVISE_FORBIDDEN, by the shared person-act check', () => {
    const revise = (f: PersonActFacts) =>
      personActRefusal(f, 'p', 'revising a suggestion', 'SUGGESTION_REVISE_FORBIDDEN')?.code ??
      null;
    expect(revise(person)).toBeNull();
    expect(revise({ ...person, agency: 'agent' })).toBe('SUGGESTION_REVISE_FORBIDDEN');
    expect(revise({ ...person, role: 'viewer' })).toBe('SUGGESTION_REVISE_FORBIDDEN');
  });

  it('its producer is SUGGESTION_REVISE_FORBIDDEN, and the reviewer then produced the revision', () => {
    expect(reviseProducerRefusal('u1', 'p1')).toBeNull();
    expect(reviseProducerRefusal('u1', null)).toBeNull();
    expect(reviseProducerRefusal('p1', 'p1')?.code).toBe('SUGGESTION_REVISE_FORBIDDEN');
    expect(producerRefusal('u1', 'u1')?.code).toBe('SUGGESTION_ACCEPT_FORBIDDEN');
  });

  it('a payload that proposes the same change is SUGGESTION_REVISION_UNCHANGED', () => {
    const before = fingerprintOf('triage', { note: 'n', priority: 'high' });
    expect(
      unchangedRevisionRefusal(
        before,
        fingerprintOf('triage', { priority: 'high', note: 'n' }),
        's1',
      )?.code,
    ).toBe('SUGGESTION_REVISION_UNCHANGED');
    expect(
      unchangedRevisionRefusal(
        before,
        fingerprintOf('triage', { note: 'n', priority: 'low' }),
        's1',
      ),
    ).toBeNull();
  });
});

describe('a breakdown issue is sized and builds a pinned design (ISS-117, FB-60, FB-61)', () => {
  const one = { workflowId: 'w1', flow: 'automation' };
  const two = { workflowId: 'w2', flow: 'agent-run-standing' };
  const item = {
    title: 'A',
    complexity: 's' as const,
    criteria: [{ body: 'a', tracesTo: 'BC-1' }],
  };

  it('an item with no complexity is SUGGESTION_PAYLOAD_INVALID at its path', () => {
    const refused = payloadRefusal('breakdown', 'requirement', {
      issues: [{ title: 'A', criteria: [{ body: 'a', tracesTo: 'BC-1' }] }],
    });
    expect(refused).toMatchObject({
      code: 'SUGGESTION_PAYLOAD_INVALID',
      path: '/payload/issues/0/complexity',
    });
    expect(
      payloadRefusal('breakdown', 'requirement', {
        issues: [{ ...item, priority: 'high', category: 'chore', builds: null }],
      }),
    ).toBeNull();
  });

  it('left out, the one pinned design is taken and no pin links nothing', () => {
    expect(breakdownBuilds({ issues: [item] }, [one])).toEqual({ builds: [one], refusals: [] });
    expect(breakdownBuilds({ issues: [item] }, [])).toEqual({ builds: [null], refusals: [] });
    expect(breakdownBuilds({ issues: [{ ...item, builds: null }] }, [one]).builds).toEqual([null]);
  });

  it('several pinned and none named is SUGGESTION_BUILD_UNNAMED, a named one is taken', () => {
    const unnamed = breakdownBuilds({ issues: [item] }, [one, two]);
    expect(unnamed.refusals).toEqual([
      expect.objectContaining({
        code: 'SUGGESTION_BUILD_UNNAMED',
        path: '/payload/issues/0/builds',
      }),
    ]);
    expect(unnamed.refusals[0]?.detail).toContain('automation, agent-run-standing');
    expect(
      breakdownBuilds({ issues: [{ ...item, builds: 'agent-run-standing' }] }, [one, two]).builds,
    ).toEqual([two]);
  });

  it('a flow the baseline does not pin is SUGGESTION_BUILD_UNPINNED', () => {
    const unpinned = breakdownBuilds({ issues: [item, { ...item, builds: 'billing' }] }, [one]);
    expect(unpinned.refusals).toEqual([
      expect.objectContaining({
        code: 'SUGGESTION_BUILD_UNPINNED',
        path: '/payload/issues/1/builds',
      }),
    ]);
  });
});

describe('step breakdown: the project master proposes one open breakdown per revision', () => {
  const agent = { userId: 'm1', agency: 'agent' as const, role: 'member' as const };

  it('the project agent proposes; a person, the BA assistant and another project agent are refused', () => {
    expect(breakdownProposerRefusal(agent, 'agent')).toBeNull();
    expect(breakdownProposerRefusal(person, 'person')).toMatchObject({
      code: 'SUGGESTION_BREAKDOWN_PROPOSE_FORBIDDEN',
    });
    expect(breakdownProposerRefusal(agent, 'ba_assistant')?.detail).toContain('the BA assistant');
    expect(breakdownProposerRefusal({ ...agent, role: null }, 'agent')?.detail).toContain(
      'not an agent of this project',
    );
  });

  it('a second open breakdown on the revision is SUGGESTION_BREAKDOWN_OPEN naming the open one', () => {
    expect(breakdownOpenRefusal(null, 2)).toBeNull();
    expect(breakdownOpenRefusal('s9', 2)).toMatchObject({
      code: 'SUGGESTION_BREAKDOWN_OPEN',
      detail: expect.stringContaining('s9'),
    });
  });

  it('an issue with no criterion, or a criterion with no BC trace, does not parse', () => {
    const bare = { title: 'A', complexity: 's' };
    expect(payloadRefusal('breakdown', 'requirement', { issues: [bare] })).toMatchObject({
      path: '/payload/issues/0/criteria',
    });
    expect(
      payloadRefusal('breakdown', 'requirement', { issues: [{ ...bare, criteria: [] }] }),
    ).toMatchObject({ path: '/payload/issues/0/criteria' });
    expect(
      payloadRefusal('breakdown', 'requirement', {
        issues: [{ ...bare, criteria: [{ body: 'x' }] }],
      }),
    ).toMatchObject({ path: '/payload/issues/0/criteria/0/tracesTo' });
  });
});
