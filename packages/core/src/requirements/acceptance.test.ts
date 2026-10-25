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

const { acceptRefusals, decisionRefusals, dropRefusals, liveIssueRefusal, provenRefusal } =
  await import('./acceptance-rules.js');
const { deliveryAt } = await import('./standing.js');
const { consumerOf } = await import('../outbox/consumers.js');
const { registerMasterWakeSubscribers } = await import('../ws/master-wake.js');

const codes = (rs: { code: string }[]) => rs.map((r) => r.code);

describe('accepting a delivered requirement: the state the accept asks', () => {
  it("lets an agreed requirement through at its head; its delivery is the checklist's", () => {
    expect(acceptRefusals({ status: 'agreed', named: 3, head: 3 })).toEqual([]);
  });

  it('refuses a revision other than the head as stale, naming the head', () => {
    const [r] = acceptRefusals({ status: 'agreed', named: 2, head: 3 });
    expect(r?.code).toBe('REQUIREMENT_REVISION_STALE');
    expect(r?.detail).toContain('the head is revision 3');
  });

  it('refuses a draft, deferred or already accepted requirement by name', () => {
    expect(codes(acceptRefusals({ status: 'draft', named: 1, head: 1 }))).toEqual([
      'REQUIREMENT_NOT_DELIVERED',
    ]);
    expect(codes(acceptRefusals({ status: 'deferred', named: 1, head: 1 }))).toEqual([
      'REQUIREMENT_DEFERRED',
    ]);
    expect(codes(acceptRefusals({ status: 'accepted', named: 1, head: 1 }))).toEqual([
      'REQUIREMENT_ALREADY_ACCEPTED',
    ]);
  });
});

describe('dropping a requirement', () => {
  const droppable = entriesOf(REQUIREMENT_MACHINE, 'dropped');

  it('the machine lets draft, agreed, in delivery and deferred leave for dropped, and nothing else', () => {
    expect([...droppable].sort()).toEqual(['agreed', 'deferred', 'draft', 'in_delivery']);
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

describe('the coverage the move to delivered and the accept read (REQ-74 BC-10)', () => {
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
  const verdict = (v: 'pass' | 'fail' | null, byBuilder = false) => [
    {
      issueId: 'i1',
      n: 1,
      requirementCriterionId: 'c1',
      verdict: v,
      verdictAt: v ? at : null,
      identity: v ? ({ kind: 'commit', sha: 'f'.repeat(40) } as const) : null,
      byBuilder,
      authored: true,
      recordedAt: v ? at : null,
    },
  ];

  it('lets the move to delivered through when every BC passes, a dropped issue left out, and reads no phase', () => {
    const { delivery, coverage } = deliveryAt(
      {
        status: 'agreed',
        criteria,
        issues: [issue('i1', 'closed'), issue('i2', 'dropped')],
        issueCriteria: verdict('pass'),
        judge: 'independent',
        liveBuild: {
          sha: 'f'.repeat(40),
          holds: new Map([['f'.repeat(40), true]]),
          runtimes: new Map(),
          unanswered: new Map(),
        },
      },
      1,
    );
    expect(delivery).not.toHaveProperty('phase');
    expect(delivery.liveIssues).toBe(1);
    expect(provenRefusal(coverage)).toBeNull();
  });

  // ISS-489 r3: an unread live build counted the pass, so an outage could read a requirement delivered
  it('reads in_delivery where the pass sits on a commit nobody could check against the live build', () => {
    const { delivery, coverage } = deliveryAt(
      {
        status: 'agreed',
        criteria,
        issues: [issue('i1', 'closed')],
        issueCriteria: verdict('pass'),
        judge: 'independent',
        liveBuild: {
          sha: null,
          holds: new Map(),
          runtimes: new Map(),
          unanswered: new Map([['f'.repeat(40), 'the live build could not be read: no probe']]),
        },
      },
      1,
    );
    expect(delivery).not.toHaveProperty('phase');
    expect(coverage[0]?.verdict).toBe('not_judged');
    expect(provenRefusal(coverage)?.code).toBe('REQUIREMENT_CRITERIA_UNPROVEN');
  });

  // REQ-35 decision 7b261fca: the accept read the builder's own pass as proof, under independent QA
  it("refuses delivered where the only pass is the builder's own and the project judges apart", () => {
    const { delivery, coverage } = deliveryAt(
      {
        status: 'agreed',
        criteria,
        issues: [issue('i1', 'closed')],
        issueCriteria: verdict('pass', true),
        judge: 'independent',
        liveBuild: {
          sha: 'f'.repeat(40),
          holds: new Map([['f'.repeat(40), true]]),
          runtimes: new Map(),
          unanswered: new Map(),
        },
      },
      1,
    );
    expect(delivery).not.toHaveProperty('phase');
    expect(coverage[0]?.verdict).toBe('not_judged');
    expect(coverage[0]?.why).toContain('passed by the run that built it');
    expect(provenRefusal(coverage)?.detail).toContain('BC-1 (not judged: ');
  });

  it('refuses delivered when every issue closed but a BC is unproven, naming it', () => {
    const { delivery, coverage } = deliveryAt(
      {
        status: 'agreed',
        criteria,
        issues: [issue('i1', 'closed')],
        issueCriteria: verdict(null),
        judge: 'independent',
      },
      1,
    );
    expect(delivery).not.toHaveProperty('phase');
    expect(coverage[0]?.verdict).toBe('not_judged');
    expect(provenRefusal(coverage)?.detail).toContain('BC-1');
  });

  it('refuses delivered with no live criterion at all', () => {
    expect(provenRefusal([])?.code).toBe('REQUIREMENT_CRITERIA_UNPROVEN');
  });
});

describe('the move into delivery and the accept by decision (REQ-74 BC-9)', () => {
  it('moves into delivery only with a live issue linked', () => {
    expect(liveIssueRefusal(1)).toBeNull();
    expect(liveIssueRefusal(0)?.code).toBe('REQUIREMENT_NO_LIVE_ISSUE');
  });

  it('accepts an agreed, in delivery or delivered requirement at its head', () => {
    for (const status of ['agreed', 'in_delivery', 'delivered'] as const) {
      expect(acceptRefusals({ status, named: 2, head: 2 })).toEqual([]);
    }
  });

  it('refuses a decision with no reason and one over unfinished issues, naming each', () => {
    expect(codes(decisionRefusals({ reason: ' ', unfinished: [] }))).toEqual([
      'REQUIREMENT_DECISION_REASON_REQUIRED',
    ]);
    const [r] = decisionRefusals({ reason: 'the owner closed it', unfinished: ['ISS-4', 'ISS-9'] });
    expect(r?.code).toBe('REQUIREMENT_HAS_UNFINISHED_ISSUES');
    expect(r?.detail).toContain('ISS-4, ISS-9');
    expect(decisionRefusals({ reason: 'the owner closed it', unfinished: [] })).toEqual([]);
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
