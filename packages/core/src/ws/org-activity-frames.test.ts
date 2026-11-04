/**
 * ISS-951: a workspace's Activity page hears, in the `org:<id>` room, that one of the org's projects
 * moved — what runs there now, an issue's step or status, a run, a question — and nothing else: the
 * frame names the org, the project and what moved, and the page reads its activity again.
 *
 * @direct-test-of packages/core/src/ws/broadcast-subscribers.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (payload: unknown) => unknown>();
const published: Array<{ room: string; event: string; data: unknown }> = [];
const orgs = new Map<string, string>([
  ['p1', 'o1'],
  ['p2', 'o2'],
]);

vi.mock('../outbox/index.js', () => ({
  consume: (type: string, consumer: { handle: (payload: unknown) => unknown }) => {
    handlers.set(type, consumer.handle);
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
  findProjectOrgId: vi.fn(async (projectId: string) => orgs.get(projectId) ?? null),
}));
vi.mock('../pipeline/index.js', () => ({
  runStatusView: vi.fn(async (id: string) => ({ runId: id, projectId: 'p2', issueId: null, status: 'running' })),
}));

const { registerWsBroadcastSubscribers } = await import('./broadcast-subscribers.js');

const orgFrames = () => published.filter((p) => p.event === 'org.activity.changed');

const nowPush = (projectId: string | null, source: string, event = 'project.now.changed') => ({
  projectId,
  deviceId: null,
  userIds: [],
  event,
  data: { projectId, source },
});

describe('the org room hears what moved on its projects', () => {
  beforeEach(() => {
    handlers.clear();
    published.length = 0;
    registerWsBroadcastSubscribers();
  });

  it.each(['runs', 'master', 'rooms', 'step'])('a project.now.changed of %s reaches the org room', async (source) => {
    await handlers.get('session.pushed')?.(nowPush('p1', source));
    expect(published.map((p) => p.room)).toEqual(['project:p1', 'org:o1']);
    expect(orgFrames()).toEqual([
      { room: 'org:o1', event: 'org.activity.changed', data: { orgId: 'o1', projectId: 'p1', source } },
    ]);
  });

  it('an issue status move and a new issue reach the org room as a status change', async () => {
    await handlers.get('issue.transitioned')?.({
      id: 'i1',
      projectId: 'p1',
      from: 'open',
      to: 'in_progress',
      actor: { id: 'u1' },
      reason: null,
      at: '2026-11-04T00:00:00.000Z',
    });
    await handlers.get('issue.created')?.({ issueId: 'i2', projectId: 'p1', actor: { id: 'u1' } });
    expect(orgFrames().map((f) => (f.data as { source: string }).source)).toEqual(['status', 'status']);
  });

  it('a run move reaches the org of the run project', async () => {
    await handlers.get('run.transitioned')?.({ id: 'r1' });
    expect(orgFrames()).toEqual([
      { room: 'org:o2', event: 'org.activity.changed', data: { orgId: 'o2', projectId: 'p2', source: 'run' } },
    ]);
  });

  it('a session frame that is not about what runs now tells no org', async () => {
    await handlers.get('session.pushed')?.(nowPush('p1', 'runs', 'agent-session.updated'));
    expect(orgFrames()).toEqual([]);
  });

  it('a push naming no project, or a project gone, tells no org', async () => {
    await handlers.get('session.pushed')?.(nowPush(null, 'runs'));
    await handlers.get('session.pushed')?.(nowPush('p-gone', 'runs'));
    expect(orgFrames()).toEqual([]);
  });

  it('the frame carries the org, the project and what moved, and nothing of the project', async () => {
    await handlers.get('question.asked')?.({ questionId: 'q1', projectId: 'p1', issueId: 'i1' });
    const [f] = orgFrames();
    expect(Object.keys(f?.data as object).sort()).toEqual(['orgId', 'projectId', 'source']);
  });
});
