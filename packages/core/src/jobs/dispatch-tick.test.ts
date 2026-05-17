/**
 * ISS-40 PR-E / ISS-162 — dispatch-tick lock + debounce + iteration tests.
 * We mock `pickNextDispatchableJobForProject` and `handleDispatch` so we can
 * drive the inner sweep deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pickFn = vi.fn();
const handleDispatch = vi.fn();
const dbExecute = vi.fn();

const wsPublish = vi.fn();

vi.mock('./dispatch-gates.js', () => ({
  pickNextDispatchableJobForProject: pickFn,
}));

// dispatch-tick statically imports `handleDispatch` from './dispatcher.js'.
// vi.mock hoists above the static import so the mocked module is in place
// before runTickInner ever runs.
vi.mock('./dispatcher.js', () => ({
  handleDispatch,
}));

vi.mock('../db/client.js', () => ({
  db: {
    execute: dbExecute,
  },
}));

vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => wsPublish(...args) },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  dispatchTickForProject,
  setDispatchTickDebounceMs,
  dispatchTickAllProjectsWithQueued,
} = await import('./dispatch-tick.js');

beforeEach(() => {
  vi.clearAllMocks();
  // `mockClear` does not drain the `mockResolvedValueOnce` queue. The
  // `coalesces` test below stubs a `mockResolvedValueOnce(null)` that goes
  // unconsumed (only one pickFn call happens), which would otherwise bleed
  // into the next test and skip its first dispatch. `mockReset` clears the
  // queue and the impl; we re-stub per-test.
  pickFn.mockReset();
  handleDispatch.mockReset();
  setDispatchTickDebounceMs(0); // disable debounce for deterministic tests
  wsPublish.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchTickForProject', () => {
  it('iterates until pick returns null', async () => {
    pickFn
      .mockResolvedValueOnce({ id: 'j1' })
      .mockResolvedValueOnce({ id: 'j2' })
      .mockResolvedValueOnce(null);
    handleDispatch.mockResolvedValue('dispatched');

    await dispatchTickForProject('p1');

    expect(handleDispatch).toHaveBeenCalledTimes(2);
    expect(handleDispatch).toHaveBeenNthCalledWith(1, { jobId: 'j1' });
    expect(handleDispatch).toHaveBeenNthCalledWith(2, { jobId: 'j2' });
  });

  // ISS-162 — picker is stateless; an L4-blocked candidate would keep being
  // returned. The tick breaks on first `skipped` outcome so the loop never
  // burns CPU; the next external trigger or 60s backstop re-enters.
  it('breaks the loop when handleDispatch returns skipped', async () => {
    pickFn.mockResolvedValue({ id: 'j-stuck' });
    handleDispatch.mockResolvedValue('skipped');
    await dispatchTickForProject('p1');
    expect(handleDispatch).toHaveBeenCalledTimes(1);
  });

  it('coalesces: a second trigger while one is pending is dropped', async () => {
    let resolveFirst: (v?: unknown) => void = () => {};
    const firstPick = new Promise((r) => {
      resolveFirst = r;
    });
    pickFn
      .mockImplementationOnce(() => firstPick.then(() => null));
    // second .mock would be triggered if dropping doesn't work
    pickFn.mockResolvedValueOnce(null);

    const a = dispatchTickForProject('p1');
    const b = dispatchTickForProject('p1');
    // b should be a dropped no-op (resolves immediately with undefined)
    await b;
    resolveFirst();
    await a;
    // pickFn called only once across both triggers
    expect(pickFn).toHaveBeenCalledTimes(1);
  });

  // ISS-162 acceptance: a throw inside runTickInner must NOT poison the
  // project's tick path. After the throw, the project's lock entry is
  // cleared so the next external trigger starts a fresh chain.
  it('self-healing lock: a throw in the inner sweep does not poison subsequent ticks', async () => {
    pickFn.mockRejectedValueOnce(new Error('boom'));

    await dispatchTickForProject('p-self-heal');

    // Second trigger must run pickFn again (lock cleared).
    pickFn.mockResolvedValueOnce(null);
    await dispatchTickForProject('p-self-heal');

    expect(pickFn).toHaveBeenCalledTimes(2);
    expect(pickFn).toHaveBeenNthCalledWith(1, 'p-self-heal');
    expect(pickFn).toHaveBeenNthCalledWith(2, 'p-self-heal');
  });
});

describe('dispatchTickForProject — dependency.unblocked event', () => {
  const ISSUE_ID = 'issue-1';
  const BLOCKER_ID = 'blocker-1';

  // ISS-162 — emit condition is now keyed on `triggerBlockerIssueId` (the
  // terminal-transition cascade is the only caller that sets it) rather
  // than a persisted prior gate reason. A dispatched job + supplied blocker
  // → emit; anything else → no emit.
  it('emits dependency.unblocked when a dispatched job has triggerBlockerIssueId', async () => {
    pickFn
      .mockResolvedValueOnce({ id: 'j1', issueId: ISSUE_ID })
      .mockResolvedValueOnce(null);
    handleDispatch.mockResolvedValue('dispatched');

    await dispatchTickForProject('p1', { triggerBlockerIssueId: BLOCKER_ID });

    const matched = wsPublish.mock.calls.find(
      (c) => (c[1] as { event: string }).event === 'dependency.unblocked',
    );
    expect(matched).toBeDefined();
    const [room, envelope] = matched as [string, { event: string; data: Record<string, unknown> }];
    expect(room).toBe('project:p1');
    expect(envelope.data).toMatchObject({
      issueId: ISSUE_ID,
      blockerId: BLOCKER_ID,
    });
  });

  it('does not emit when triggerBlockerIssueId is absent', async () => {
    pickFn
      .mockResolvedValueOnce({ id: 'j1', issueId: ISSUE_ID })
      .mockResolvedValueOnce(null);
    handleDispatch.mockResolvedValue('dispatched');

    await dispatchTickForProject('p1');

    const matched = wsPublish.mock.calls.find(
      (c) => (c[1] as { event: string }).event === 'dependency.unblocked',
    );
    expect(matched).toBeUndefined();
  });

  it('does not emit when handleDispatch returns skipped', async () => {
    pickFn
      .mockResolvedValueOnce({ id: 'j1', issueId: ISSUE_ID })
      .mockResolvedValueOnce(null);
    handleDispatch.mockResolvedValue('skipped');

    await dispatchTickForProject('p1', { triggerBlockerIssueId: BLOCKER_ID });

    const matched = wsPublish.mock.calls.find(
      (c) => (c[1] as { event: string }).event === 'dependency.unblocked',
    );
    expect(matched).toBeUndefined();
  });
});

describe('dispatchTickAllProjectsWithQueued', () => {
  it('fans out to every distinct project with queued work', async () => {
    dbExecute.mockResolvedValueOnce([
      { project_id: 'pa' },
      { project_id: 'pb' },
    ]);
    pickFn.mockResolvedValue(null);

    await dispatchTickAllProjectsWithQueued();
    // micro-task drain so the fire-and-forget ticks land
    await new Promise((r) => setTimeout(r, 50));
    expect(pickFn).toHaveBeenCalledWith('pa');
    expect(pickFn).toHaveBeenCalledWith('pb');
  });

  it('skips rows with null project_id', async () => {
    dbExecute.mockResolvedValueOnce([{ project_id: null }, { project_id: 'pc' }]);
    pickFn.mockResolvedValue(null);
    await dispatchTickAllProjectsWithQueued();
    await new Promise((r) => setTimeout(r, 50));
    expect(pickFn).toHaveBeenCalledTimes(1);
    expect(pickFn).toHaveBeenCalledWith('pc');
  });
});
