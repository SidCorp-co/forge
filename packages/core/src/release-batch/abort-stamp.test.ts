import { describe, expect, it } from 'vitest';
import { abortAccount, batchAborted, readAbortStamp } from './abort-stamp.js';

const stamp = (roster: unknown) => ({
  abort: { id: 's-1', at: '2026-09-25T00:00:00.000Z', reason: 'stopped', by: 'u-1', roster },
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
    });
  });

  it('reads no stamp from a roster value it does not know, or from none at all', () => {
    expect(readAbortStamp(stamp('gone'))).toBeNull();
    expect(readAbortStamp({ abort: 'yes' })).toBeNull();
    expect(readAbortStamp({})).toBeNull();
    expect(readAbortStamp(null)).toBeNull();
  });
});

describe('abortAccount — what the abort did, off the run', () => {
  it('says shipped wherever the release was stamped, whatever the abort held', () => {
    expect(abortAccount({ shipped: true, metadata: stamp('held') })).toBe('shipped');
    expect(abortAccount({ shipped: true, metadata: {} })).toBe('shipped');
  });

  it('takes the roster off the stamp for a release that never shipped', () => {
    expect(abortAccount({ shipped: false, metadata: stamp('held') })).toBe('held');
    expect(abortAccount({ shipped: false, metadata: stamp('returning') })).toBe('returning');
    expect(abortAccount({ shipped: false, metadata: stamp('released') })).toBe('released');
  });

  it('says unrecorded where no abort stamped the run', () => {
    expect(abortAccount({ shipped: false, metadata: {} })).toBe('unrecorded');
  });
});
