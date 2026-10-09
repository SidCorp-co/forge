import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import { entriesOf } from '@forge/contracts/state-machine';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const published = vi.hoisted(() => [] as { room: string; frame: unknown }[]);

vi.mock('../db/client.js', () => ({
  db: {
    selectDistinct: () => ({ from: () => ({ where: async () => [{ deviceId: 'box-1' }] }) }),
  },
}));
vi.mock('../lib/rooms.js', () => ({
  deviceRoom: (id: string) => `device:${id}`,
  roomManager: {
    publish: (room: string, frame: unknown) => {
      published.push({ room, frame });
      return 1;
    },
  },
}));

const { acceptRefusals, dropRefusals } = await import('./acceptance-rules.js');
const { deliveryAt } = await import('./standing.js');
const { consumerOf } = await import('../outbox/consumers.js');
const { registerMasterWakeSubscribers } = await import('../ws/master-wake.js');

type Proof = Parameters<typeof acceptRefusals>[0]['proof'];
const delivered: Proof = { liveIssues: 2, unshipped: [], unproven: [] };
const codes = (rs: { code: string }[]) => rs.map((r) => r.code);

describe('accepting a delivered requirement', () => {
  it('accepts an agreed requirement at its head when every issue shipped and every BC is proven', () => {
    expect(acceptRefusals({ status: 'agreed', named: 3, head: 3, proof: delivered })).toEqual([]);
  });

  it('refuses a revision other than the head as stale, naming the head', () => {
    const [r] = acceptRefusals({ status: 'agreed', named: 2, head: 3, proof: delivered });
    expect(r?.code).toBe('REQUIREMENT_REVISION_STALE');
    expect(r?.detail).toContain('the head is revision 3');
  });

  it('refuses while a live linked issue is not closed, naming it', () => {
    const [r] = acceptRefusals({
      status: 'agreed',
      named: 3,
      head: 3,
      proof: { liveIssues: 2, unshipped: ['ISS-9'], unproven: [] },
    });
    expect(r?.code).toBe('REQUIREMENT_NOT_DELIVERED');
    expect(r?.detail).toContain('ISS-9');
  });

  it('refuses a requirement no live issue links to: nothing was delivered', () => {
    const rs = acceptRefusals({
      status: 'agreed',
      named: 1,
      head: 1,
      proof: { liveIssues: 0, unshipped: [], unproven: [] },
    });
    expect(codes(rs)).toEqual(['REQUIREMENT_NOT_DELIVERED']);
  });

  it('refuses a shipped requirement with an unproven business criterion, naming each with its verdict', () => {
    const [r] = acceptRefusals({
      status: 'agreed',
      named: 3,
      head: 3,
      proof: {
        liveIssues: 1,
        unshipped: [],
        unproven: [
          { code: 'BC-2', verdict: 'not_judged', why: null },
          { code: 'BC-4', verdict: 'gap', why: null },
        ],
      },
    });
    expect(r?.code).toBe('REQUIREMENT_CRITERIA_UNPROVEN');
    expect(r?.detail).toContain('BC-2 (not judged), BC-4 (gap)');
  });

  // ISS-489 r3: a pass nobody could check against the live build leaves its BC not judged; the
  // refusal names that reason, so an outage is not read as a criterion nobody judged
  it('names the reason a criterion is unproven where coverage gives one', () => {
    const [r] = acceptRefusals({
      status: 'agreed',
      named: 3,
      head: 3,
      proof: {
        liveIssues: 1,
        unshipped: [],
        unproven: [
          {
            code: 'BC-2',
            verdict: 'not_judged',
            why: 'no verdict counts yet: ISS-1 criterion 1: judged at commit ffffffffffff, and whether the live build holds it could not be checked: the live build could not be read: no probe',
          },
        ],
      },
    });
    expect(r?.detail).toBe(
      'every current business criterion is proven by a passing verdict before the accept; not proven: BC-2 (not judged: no verdict counts yet: ISS-1 criterion 1: judged at commit ffffffffffff, and whether the live build holds it could not be checked: the live build could not be read: no probe).',
    );
  });

  it('names every cause at once', () => {
    const rs = acceptRefusals({
      status: 'agreed',
      named: 1,
      head: 2,
      proof: {
        liveIssues: 1,
        unshipped: ['ISS-1'],
        unproven: [{ code: 'BC-1', verdict: 'failing', why: null }],
      },
    });
    expect(codes(rs)).toEqual([
      'REQUIREMENT_REVISION_STALE',
      'REQUIREMENT_NOT_DELIVERED',
      'REQUIREMENT_CRITERIA_UNPROVEN',
    ]);
  });

  it('refuses a draft, deferred or already accepted requirement by name', () => {
    expect(codes(acceptRefusals({ status: 'draft', named: 1, head: 1, proof: delivered }))).toEqual(
      ['REQUIREMENT_NOT_DELIVERED'],
    );
    expect(
      codes(acceptRefusals({ status: 'deferred', named: 1, head: 1, proof: delivered })),
    ).toEqual(['REQUIREMENT_DEFERRED']);
    expect(
      codes(acceptRefusals({ status: 'accepted', named: 1, head: 1, proof: delivered })),
    ).toEqual(['REQUIREMENT_ALREADY_ACCEPTED']);
  });
});

describe('dropping a requirement', () => {
  const droppable = entriesOf(REQUIREMENT_MACHINE, 'dropped');

  it('the machine lets draft, agreed and deferred leave for dropped, and nothing else', () => {
    expect([...droppable].sort()).toEqual(['agreed', 'deferred', 'draft']);
  });

  it('drops with a reason and no live linked issue', () => {
    expect(
      dropRefusals({ status: 'agreed', droppable, reason: 'out of scope', liveIssues: [] }),
    ).toEqual([]);
  });

  it('refuses a drop with no reason', () => {
    const rs = dropRefusals({ status: 'draft', droppable, reason: '  ', liveIssues: [] });
    expect(codes(rs)).toEqual(['REQUIREMENT_DROP_REASON_REQUIRED']);
  });

  it('refuses while a live issue links to it, naming each', () => {
    const [r] = dropRefusals({
      status: 'agreed',
      droppable,
      reason: 'x',
      liveIssues: ['ISS-4', 'ISS-7'],
    });
    expect(r?.code).toBe('REQUIREMENT_HAS_LIVE_ISSUES');
    expect(r?.detail).toContain('ISS-4, ISS-7');
  });

  it('refuses an accepted or dropped requirement', () => {
    expect(
      codes(dropRefusals({ status: 'accepted', droppable, reason: 'x', liveIssues: [] })),
    ).toEqual(['REQUIREMENT_NOT_DROPPABLE']);
    expect(
      codes(dropRefusals({ status: 'dropped', droppable, reason: 'x', liveIssues: [] })),
    ).toEqual(['REQUIREMENT_NOT_DROPPABLE']);
  });
});

describe('the delivery phase the accept reads', () => {
  const at = new Date('2026-10-05T00:00:00Z');
  const issue = (id: string, status: string) => ({
    id,
    displayId: id,
    title: id,
    status,
    tone: 'neutral' as const,
    updatedAt: at,
    closedAt: null,
    changedSincePlan: false,
  });
  const criteria = [{ id: 'c1', code: 'BC-1', body: 'b', sinceRevision: 1, retiredRevision: null }];
  const verdict = (v: 'pass' | 'fail' | null) => [
    {
      issueId: 'i1',
      n: 1,
      requirementCriterionId: 'c1',
      verdict: v,
      verdictAt: v ? at : null,
      identity: v ? ({ kind: 'commit', sha: 'f'.repeat(40) } as const) : null,
    },
  ];

  it('reads delivered when every live issue closed and every BC passes, a dropped issue left out', () => {
    const { delivery } = deliveryAt(
      {
        status: 'agreed',
        criteria,
        issues: [issue('i1', 'closed'), issue('i2', 'dropped')],
        issueCriteria: verdict('pass'),
        liveBuild: {
          sha: 'f'.repeat(40),
          holds: new Map([['f'.repeat(40), true]]),
          runtimes: new Map(),
          unanswered: new Map(),
        },
      },
      1,
    );
    expect(delivery.phase).toBe('delivered');
  });

  // ISS-489 r3: an unread live build counted the pass, so an outage could read a requirement delivered
  it('reads in_delivery where the pass sits on a commit nobody could check against the live build', () => {
    const { delivery, coverage } = deliveryAt(
      {
        status: 'agreed',
        criteria,
        issues: [issue('i1', 'closed')],
        issueCriteria: verdict('pass'),
        liveBuild: {
          sha: null,
          holds: new Map(),
          runtimes: new Map(),
          unanswered: new Map([['f'.repeat(40), 'the live build could not be read: no probe']]),
        },
      },
      1,
    );
    expect(delivery.phase).toBe('in_delivery');
    expect(coverage[0]?.verdict).toBe('not_judged');
  });

  it('reads in_delivery when every issue closed but a BC is unproven', () => {
    const { delivery, coverage } = deliveryAt(
      { status: 'agreed', criteria, issues: [issue('i1', 'closed')], issueCriteria: verdict(null) },
      1,
    );
    expect(delivery.phase).toBe('in_delivery');
    expect(coverage[0]?.verdict).toBe('not_judged');
  });
});

describe('the requirement.agreed wake', () => {
  beforeAll(() => registerMasterWakeSubscribers());

  it('is declared on the outbox for the master wake', () => {
    expect(OUTBOX_CONSUMERS['requirement.agreed']).toContain('master-wake');
  });

  it('wakes every box serving the project, naming the requirement as its source', async () => {
    const consumer = consumerOf('requirement.agreed', 'master-wake');
    expect(consumer).toBeDefined();
    published.length = 0;
    await consumer?.handle(
      { projectId: 'p1', requirementId: 'r1', key: 'REQ-3', revision: 2, baselineSeq: 1 },
      {} as never,
    );
    expect(published).toEqual([
      {
        room: 'device:box-1',
        frame: {
          event: 'master.wake',
          data: {
            projectId: 'p1',
            source: 'requirement',
            requirementId: 'r1',
            key: 'REQ-3',
            revision: 2,
          },
        },
      },
    ]);
  });
});
