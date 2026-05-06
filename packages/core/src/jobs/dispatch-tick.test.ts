/**
 * ISS-40 PR-E — dispatch-tick lock + debounce + iteration tests. We mock
 * `pickNextDispatchableJobForProject` and `handleDispatch` so we can drive
 * the inner sweep deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pickFn = vi.fn();
const handleDispatch = vi.fn();
const dbExecute = vi.fn();

vi.mock('./dispatch-gates.js', () => ({
  pickNextDispatchableJobForProject: pickFn,
}));

// dispatch-tick lazy-imports './dispatcher.js' inside runTickInner. Mock the
// path under both forms — vi.mock matches by source string.
vi.mock('./dispatcher.js', () => ({
  handleDispatch,
}));

vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute },
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
  setDispatchTickDebounceMs(0); // disable debounce for deterministic tests
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

  it('breaks the loop when pick returns the same job id twice (avoids hot-loop)', async () => {
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
