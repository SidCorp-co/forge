/**
 * ISS-951: a workspace's Activity page hears, in the `org:<id>` room, that one of the org's projects
 * moved — what runs there now, an issue's step or status, a run, a question — and nothing else: the
 * frame names the org, the project and what moved, and the page reads its activity again.
 *
 * The org frame is its own delivery, beside the project frame's: an org lookup that throws fails
 * only that delivery, which the outbox logs and retries alone, so the project room hears its frame
 * once and the org room is still told.
 *
 * @direct-test-of packages/core/src/ws/broadcast-subscribers.ts
 * @direct-test-of packages/contracts/src/outbox-consumers.ts
 */

import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every registered consumer by event type, then by its name, as the outbox worker finds it. */
const consumers = new Map<string, Map<string, (payload: unknown) => unknown>>();
const published: Array<{ room: string; event: string; data: unknown }> = [];
const orgs = new Map<string, string>([
  ['p1', 'o1'],
  ['p2', 'o2'],
]);
const lookup = vi.hoisted(() => ({ fails: 0 }));

vi.mock('../outbox/index.js', () => ({
  consume: (type: string, consumer: { name: string; handle: (payload: unknown) => unknown }) => {
    const byName = consumers.get(type) ?? new Map();
    byName.set(consumer.name, consumer.handle);
    consumers.set(type, byName);
  },
  emitEvent: vi.fn(),
}));
vi.mock('../lib/rooms.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rooms.js')>();
  return {
    ...real,
    roomManager: {
      publish: (room: string, msg: { event: string; data: unknown }) => {
        published.push({ room, event: msg.event, data: msg.data });
        return 1;
      },
    },
  };
});
vi.mock('../projects/index.js', () => ({
  findProjectOrgId: vi.fn(async (projectId: string) => {
    if (lookup.fails > 0) {
      lookup.fails -= 1;
      throw new Error('connect ECONNREFUSED: the org lookup failed');
    }
    return orgs.get(projectId) ?? null;
  }),
}));
vi.mock('../pipeline/index.js', () => ({
  runStatusView: vi.fn(async (id: string) => ({
    runId: id,
    projectId: 'p2',
    issueId: null,
    status: 'running',
  })),
}));

const { registerWsBroadcastSubscribers } = await import('./broadcast-subscribers.js');

const orgFrames = () => published.filter((p) => p.event === 'org.activity.changed');
const projectFrames = () => published.filter((p) => p.room.startsWith('project:'));

/**
 * Hands one event to every consumer `OUTBOX_CONSUMERS` names for its type, each its own delivery as
 * the worker runs it: a delivery that throws is started again, up to `attempts` times, and only it.
 */
async function deliver(type: keyof typeof OUTBOX_CONSUMERS, payload: unknown, attempts = 3) {
  const failures: string[] = [];
  for (const name of OUTBOX_CONSUMERS[type]) {
    const handle = consumers.get(type)?.get(name);
    if (!handle) continue;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await handle(payload);
        break;
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
  }
  return failures;
}

const nowPush = (projectId: string | null, source: string, event = 'project.now.changed') => ({
  projectId,
  deviceId: null,
  userIds: [],
  event,
  data: { projectId, source },
});

describe('the org room hears what moved on its projects', () => {
  beforeEach(() => {
    consumers.clear();
    published.length = 0;
    lookup.fails = 0;
    registerWsBroadcastSubscribers();
  });

  it.each(['runs', 'master', 'rooms', 'step'])(
    'a project.now.changed of %s reaches the org room',
    async (source) => {
      await deliver('session.pushed', nowPush('p1', source));
      expect(published.map((p) => p.room)).toEqual(['project:p1', 'org:o1']);
      expect(orgFrames()).toEqual([
        {
          room: 'org:o1',
          event: 'org.activity.changed',
          data: { orgId: 'o1', projectId: 'p1', source },
        },
      ]);
    },
  );

  it('an issue status move and a new issue reach the org room as a status change', async () => {
    await deliver('issue.transitioned', {
      id: 'i1',
      projectId: 'p1',
      from: 'open',
      to: 'in_progress',
      actor: { id: 'u1' },
      reason: null,
      at: '2026-11-04T00:00:00.000Z',
    });
    await deliver('issue.created', { issueId: 'i2', projectId: 'p1', actor: { id: 'u1' } });
    expect(orgFrames().map((f) => (f.data as { source: string }).source)).toEqual([
      'status',
      'status',
    ]);
  });

  it('a run move reaches the org of the run project', async () => {
    await deliver('run.transitioned', { id: 'r1' });
    expect(orgFrames()).toEqual([
      {
        room: 'org:o2',
        event: 'org.activity.changed',
        data: { orgId: 'o2', projectId: 'p2', source: 'run' },
      },
    ]);
  });

  it('a session frame that is not about what runs now tells no org', async () => {
    await deliver('session.pushed', nowPush('p1', 'runs', 'agent-session.updated'));
    expect(orgFrames()).toEqual([]);
  });

  it('a push naming no project, or a project gone, tells no org', async () => {
    await deliver('session.pushed', nowPush(null, 'runs'));
    await deliver('session.pushed', nowPush('p-gone', 'runs'));
    expect(orgFrames()).toEqual([]);
  });

  it('the frame carries the org, the project and what moved, and nothing of the project', async () => {
    await deliver('question.asked', { questionId: 'q1', projectId: 'p1', issueId: 'i1' });
    const [f] = orgFrames();
    expect(Object.keys(f?.data as object).sort()).toEqual(['orgId', 'projectId', 'source']);
  });

  it.each([
    ['session.pushed', nowPush('p1', 'step')],
    [
      'issue.transitioned',
      {
        id: 'i1',
        projectId: 'p1',
        from: 'open',
        to: 'in_progress',
        actor: { id: 'u1' },
        reason: null,
        at: '2026-11-04T00:00:00.000Z',
      },
    ],
    ['issue.created', { issueId: 'i2', projectId: 'p1', actor: { id: 'u1' } }],
    ['question.asked', { questionId: 'q1', projectId: 'p1', issueId: 'i1' }],
    ['question.transitioned', { id: 'q1', projectId: 'p1', issueId: null, to: 'answered' }],
  ] as const)(
    'an org lookup that throws on %s leaves the project frame sent once and retries the org frame alone',
    async (type, payload) => {
      lookup.fails = 1;
      const failures = await deliver(type, payload);
      expect(projectFrames(), 'the project room heard the frame other than once').toHaveLength(1);
      expect(failures, 'the failed org lookup was swallowed, or failed another delivery').toEqual([
        'org-activity: connect ECONNREFUSED: the org lookup failed',
      ]);
      expect(orgFrames(), 'the retried org delivery never told the org room').toHaveLength(1);
    },
  );

  it('a run move whose org lookup throws sends its project frame once and retries the org frame alone', async () => {
    lookup.fails = 1;
    const failures = await deliver('run.transitioned', { id: 'r1' });
    expect(projectFrames()).toHaveLength(1);
    expect(failures).toEqual(['org-activity: connect ECONNREFUSED: the org lookup failed']);
    expect(orgFrames()).toHaveLength(1);
  });

  it('each event that tells the org room has an org-activity delivery of its own', () => {
    for (const type of [
      'session.pushed',
      'issue.transitioned',
      'issue.created',
      'question.asked',
      'question.transitioned',
      'run.transitioned',
    ] as const) {
      expect(
        OUTBOX_CONSUMERS[type] as readonly string[],
        `${type} has no org-activity delivery`,
      ).toContain('org-activity');
    }
  });
});
