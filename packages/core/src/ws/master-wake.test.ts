import { beforeEach, describe, expect, it, vi } from 'vitest';

const publish = vi.fn<(room: string, envelope: { event: string; data: unknown }) => number>();
const selectDistinct = vi.fn();

vi.mock('./server.js', () => ({
  roomManager: {
    publish: (room: string, envelope: { event: string; data: unknown }) => publish(room, envelope),
  },
}));
vi.mock('../db/client.js', () => ({ db: { selectDistinct: () => selectDistinct() } }));

const {
  MASTER_WAKE_STATUSES,
  isMasterWakeStatus,
  registerMasterWakeSubscribers,
  wakeMastersForProject,
  wakeMastersForAnswer,
} = await import('./master-wake.js');

/** `db.selectDistinct().from().where()` resolving to these rows. */
function servedBy(deviceIds: string[]): void {
  selectDistinct.mockReturnValue({
    from: () => ({ where: () => Promise.resolve(deviceIds.map((deviceId) => ({ deviceId }))) }),
  });
}

function servedByThrowing(err: Error): void {
  selectDistinct.mockReturnValue({
    from: () => ({ where: () => Promise.reject(err) }),
  });
}

/** A minimal stand-in for HooksBus that records handlers by topic. */
function fakeBus() {
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  return {
    bus: {
      on(topic: string, fn: (p: unknown) => void) {
        handlers.set(topic, [...(handlers.get(topic) ?? []), fn]);
      },
    },
    async fire(topic: string, payload: unknown) {
      for (const fn of handlers.get(topic) ?? []) fn(payload);
      await new Promise((r) => setImmediate(r));
    },
  };
}

/** The `data` of the Nth publish, narrowed once so no assertion reaches through an optional. */
function publishedEvent(nth: number): string {
  const call = publish.mock.calls[nth];
  return call ? call[1].event : '';
}

function publishedData(nth: number): Record<string, unknown> {
  const call = publish.mock.calls[nth];
  if (!call) throw new Error(`no publish at index ${nth}`);
  return call[1].data as Record<string, unknown>;
}

beforeEach(() => {
  publish.mockReset();
  publish.mockReturnValue(1);
  selectDistinct.mockReset();
});

describe('master.wake — which statuses wake a box', () => {
  // cm:guard the driver's mid-run statuses must NOT be in this set — `in_progress` and `needs_info` are an issue a master already handed to a run, so waking every box on each of them turns one issue's lifecycle into a burst of pool reads that can find nothing new by construction.
  it('wakes on the three arrival statuses and on nothing else', () => {
    expect([...MASTER_WAKE_STATUSES].sort()).toEqual(['awaiting_release', 'draft', 'open']);
    for (const s of ['open', 'draft', 'awaiting_release'] as const) {
      expect(isMasterWakeStatus(s)).toBe(true);
    }
    for (const s of ['in_progress', 'needs_info', 'closed', 'dropped'] as const) {
      expect(isMasterWakeStatus(s)).toBe(false);
    }
  });
});

describe('master.wake — who it reaches', () => {
  it('publishes one frame per box serving the project, on that box own device room', async () => {
    servedBy(['dev-a', 'dev-b']);
    const result = await wakeMastersForProject({
      projectId: 'p1',
      issueId: 'i1',
      status: 'open',
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map((c) => c[0])).toEqual(['device:dev-a', 'device:dev-b']);
    expect(publish.mock.calls[0]).toEqual([
      'device:dev-a',
      { event: 'master.wake', data: { projectId: 'p1', issueId: 'i1', status: 'open' } },
    ]);
    expect(result).toEqual({ boxes: 2, delivered: 2 });
  });

  // cm:guard the frame carries NO work, no job id and no token — a wake that carried the work would be a second dispatcher, and the box would then hold two sources of truth about what to run that nothing reconciles.
  it('carries no work, no token and no decision', async () => {
    servedBy(['dev-a']);
    await wakeMastersForProject({ projectId: 'p1', issueId: 'i1', status: 'draft' });

    expect(Object.keys(publishedData(0)).sort()).toEqual(['issueId', 'projectId', 'status']);
  });

  it('publishes nothing for a project no box is bound to', async () => {
    servedBy([]);
    expect(
      await wakeMastersForProject({ projectId: 'p1', issueId: 'i1', status: 'open' }),
      'zero BOXES is the operator-visible state — nothing on the fleet is bound to do this project work — where zero delivered is only a socket that will be back',
    ).toEqual({ boxes: 0, delivered: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  // cm:guard a box with no live socket answers 0 and that is an ORDINARY outcome, never an error — `rooms.ts:publish` returns 0 for a room with nothing subscribed, which is exactly the dropped wake the 30s sweep and the reconnect catch-up exist to cover.
  it('reports zero delivered when every socket is down, and does not treat it as a failure', async () => {
    servedBy(['dev-a', 'dev-b']);
    publish.mockReturnValue(0);
    await expect(
      wakeMastersForProject({ projectId: 'p1', issueId: 'i1', status: 'awaiting_release' }),
    ).resolves.toEqual({ boxes: 2, delivered: 0 });
  });

  // cm:guard this is the assertion that has to fail if the try/catch is removed — every caller is a hook subscriber running after its own mutation committed, so a throw here turns a successful transition into a 500 for a push that is only ever an optimisation over the timer.
  it('swallows a database failure rather than failing the transition that triggered it', async () => {
    servedByThrowing(new Error('connection terminated'));
    await expect(
      wakeMastersForProject({ projectId: 'p1', issueId: 'i1', status: 'open' }),
    ).resolves.toEqual({ boxes: 0, delivered: 0 });
  });
});

describe('master.wake — what triggers it', () => {
  it('wakes on a transition INTO a wake status', async () => {
    servedBy(['dev-a']);
    const { bus, fire } = fakeBus();
    registerMasterWakeSubscribers(bus as never);

    await fire('transition', { projectId: 'p1', issueId: 'i1', from: 'draft', to: 'open' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishedData(0).status).toBe('open');
  });

  it('stays silent on a transition into a status no master acts on', async () => {
    servedBy(['dev-a']);
    const { bus, fire } = fakeBus();
    registerMasterWakeSubscribers(bus as never);

    await fire('transition', { projectId: 'p1', issueId: 'i1', from: 'open', to: 'in_progress' });
    await fire('transition', { projectId: 'p1', issueId: 'i1', from: 'in_progress', to: 'closed' });
    expect(publish).not.toHaveBeenCalled();
  });

  // cm:guard the `issueCreated` arm is half the arrivals — an issue INSERTed straight at `open` or `draft` never passes through `transition`, so a subscriber on that topic alone pushes nothing for the commonest way work arrives, and the failure is silent because the timer still finds it.
  it('wakes on an issue created directly at a wake status', async () => {
    servedBy(['dev-a']);
    const { bus, fire } = fakeBus();
    registerMasterWakeSubscribers(bus as never);

    await fire('issueCreated', { projectId: 'p1', issueId: 'i1', status: 'draft' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishedData(0).status).toBe('draft');
  });

  it('stays silent on an issue created at a status no master acts on', async () => {
    servedBy(['dev-a']);
    const { bus, fire } = fakeBus();
    registerMasterWakeSubscribers(bus as never);

    await fire('issueCreated', { projectId: 'p1', issueId: 'i1', status: 'on_hold' });
    expect(publish).not.toHaveBeenCalled();
  });
});

// cm:why criterion 44 makes an answer a trigger source ALONGSIDE the issue-status ones, so it publishes the same event rather than a second one: `daemon/mod.rs` reads the event NAME and `projectId` and nothing else off the frame, and a new event name would be ignored by every runner already on the fleet.
describe('an answer as a wake trigger', () => {
  it('wakes every box serving the project, carrying no issue', async () => {
    servedBy(['dev-a', 'dev-b']);

    const result = await wakeMastersForAnswer({ projectId: 'p1', questionId: 'q1' });

    expect(result).toEqual({ boxes: 2, delivered: 2 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(
      publishedEvent(0),
      'the SAME event as an issue arrival: a runner that predates this reads the name and the project and re-reads the pool for itself, so an answer needs no new arm on the fleet (ISS-964 criterion 44)',
    ).toBe('master.wake');
    expect(
      publishedData(0).issueId,
      'an answer has no issue behind it, and the frame carries the null through rather than inventing one',
    ).toBeNull();
  });

  // cm:guard never throw, for the same reason the issue arms do not: the caller is `answerQuestion`, whose write has already committed, so an error raised here would turn a recorded answer into a 500 for a push that is only ever an optimisation over the box's own timer.
  it('is silent rather than throwing when the lookup fails', async () => {
    servedByThrowing(new Error('pg down'));

    expect(await wakeMastersForAnswer({ projectId: 'p1', questionId: 'q1' })).toEqual({
      boxes: 0,
      delivered: 0,
    });
  });
});
