import { describe, expect, it } from 'vitest';
import { abortAccount, batchAborted, readAbortStamp } from './abort-stamp.js';

const stamp = (roster: unknown, closed?: unknown) => ({
  abort: {
    id: 's-1',
    at: '2026-09-25T00:00:00.000Z',
    reason: 'stopped',
    by: 'u-1',
    roster,
    ...(closed === undefined ? {} : { closed }),
  },
});

describe('batchAborted — the one question every finish-side check asks', () => {
  it('reads a cancelled run as aborted, stamped or not', () => {
    expect(batchAborted({ status: 'cancelled', metadata: {} })).toBe(true);
    expect(batchAborted({ status: 'cancelled', metadata: null })).toBe(true);
  });

  it('reads a running run as aborted once an abort has stamped it, before its status moves', () => {
    expect(batchAborted({ status: 'running', metadata: stamp('released') })).toBe(true);
    expect(batchAborted({ status: 'completed', metadata: stamp('held') })).toBe(true);
  });

  it('reads a running run with no stamp as not aborted', () => {
    expect(batchAborted({ status: 'running', metadata: { finish: { state: 'verifying' } } })).toBe(
      false,
    );
    expect(batchAborted({ status: 'paused', metadata: null })).toBe(false);
  });
});

describe('readAbortStamp', () => {
  it('reads a stamp whose roster it knows', () => {
    expect(readAbortStamp(stamp('held'))).toEqual({
      id: 's-1',
      at: '2026-09-25T00:00:00.000Z',
      reason: 'stopped',
      by: 'u-1',
      roster: 'held',
      closed: null,
    });
  });

  it('reads the closed issues a settled abort recorded, keeping only ids', () => {
    expect(readAbortStamp(stamp('released', ['i-2', 7, 'i-1']))?.closed).toEqual(['i-2', 'i-1']);
    expect(readAbortStamp(stamp('released', 'i-1'))?.closed).toBeNull();
  });

  it('reads no stamp from a roster value it does not know, or from none at all', () => {
    expect(readAbortStamp(stamp('gone'))).toBeNull();
    expect(readAbortStamp({ abort: 'yes' })).toBeNull();
    expect(readAbortStamp({})).toBeNull();
    expect(readAbortStamp(null)).toBeNull();
  });
});

describe('abortAccount — what the abort did, off the run', () => {
  const account = (run: { shipped: boolean; metadata: unknown; heldClosed?: string[] }) =>
    abortAccount({ heldClosed: [], ...run });

  it('says shipped wherever the release was stamped, whatever the abort held', () => {
    expect(account({ shipped: true, metadata: stamp('held') })).toEqual({
      account: 'shipped',
      closed: null,
    });
    expect(account({ shipped: true, metadata: {} }).account).toBe('shipped');
  });

  it('takes the roster off the stamp for a release that never shipped', () => {
    expect(account({ shipped: false, metadata: stamp('held') }).account).toBe('held');
    expect(account({ shipped: false, metadata: stamp('returning') }).account).toBe('returning');
    expect(account({ shipped: false, metadata: stamp('released') }).account).toBe('released');
  });

  it('says unrecorded where no abort stamped the run, and claims no closed issues', () => {
    expect(account({ shipped: false, metadata: {} })).toEqual({
      account: 'unrecorded',
      closed: null,
    });
  });

  it('names the closed issues a released roster’s settle recorded, and none it never recorded', () => {
    expect(account({ shipped: false, metadata: stamp('released', ['i-2', 'i-1']) })).toEqual({
      account: 'released',
      closed: ['i-1', 'i-2'],
    });
    expect(account({ shipped: false, metadata: stamp('released') }).closed).toBeNull();
    expect(account({ shipped: false, metadata: stamp('returning', ['i-1']) }).closed).toBeNull();
  });

  it('joins the closed issues the last finish attempt recorded, which a claim release loses', () => {
    const metadata = { ...stamp('released', []), finish: { closed: ['i-4', 'i-2'] } };
    expect(account({ shipped: false, metadata })).toEqual({
      account: 'released',
      closed: ['i-2', 'i-4'],
    });
    const legacy = { ...stamp('released'), finish: { closed: ['i-4'] } };
    expect(account({ shipped: false, metadata: legacy }).closed).toEqual(['i-4']);
  });

  it('reads a held roster’s closed issues off its claims until the abort settles', () => {
    expect(
      account({ shipped: false, metadata: stamp('held'), heldClosed: ['i-3', 'i-1'] }).closed,
    ).toEqual(['i-1', 'i-3']);
    expect(
      account({ shipped: false, metadata: stamp('held', ['i-1']), heldClosed: [] }).closed,
    ).toEqual(['i-1']);
  });
});
