import { describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.js';
import {
  DISK_CRITICAL_FREE_PERCENT,
  DISK_TEXT_UNITS,
  DISK_TIGHT_FREE_PERCENT,
  DISK_WIRE_ROOTS,
  heartbeatDisk,
  judgeDisk,
  withDeviceDisk,
} from './disk-report.js';
import { heartbeatPatch } from './heartbeat-patch.js';

const NOW = new Date('2026-10-07T10:00:00Z');
const GIB = 1024 ** 3;
const root = (path: string, bytesPct: number, inodesPct: number) => ({
  root: path,
  bytesFree: bytesPct * GIB,
  bytesTotal: 100 * GIB,
  inodesFree: inodesPct * 10_000,
  inodesTotal: 1_000_000,
});

describe('a box reports what its scratch has left, and core judges it', () => {
  it('a readable report is stored with when core heard it, and the device read judges it', () => {
    const read = heartbeatDisk({ roots: [root('/tmp', 50, 50)] }, { id: 'd1' });
    expect(read.ack).toEqual({ disk: { accepted: true } });
    const patch = heartbeatPatch({ disk: read.report }, NOW);
    expect(patch.diskReport).toEqual({
      roots: [root('/tmp', 50, 50)],
      receivedAt: NOW.toISOString(),
    });
    const [row] = withDeviceDisk([{ id: 'd1', diskReport: patch.diskReport }]);
    expect(row?.disk?.verdict).toBe('clear');
    expect(row?.disk?.receivedAt).toBe(NOW.toISOString());
    expect(row?.disk?.roots[0]).toMatchObject({ bytesFreePercent: 50, inodesFreePercent: 50 });
  });

  it('the tighter axis decides, so inodes running out under clear bytes is critical', () => {
    const disk = judgeDisk({ roots: [root('/tmp', 60, DISK_CRITICAL_FREE_PERCENT - 4)] }, 'x');
    expect(disk.verdict).toBe('critical');
    expect(disk.roots[0]).toMatchObject({ verdict: 'critical', axis: 'inodes' });
  });

  it.each([
    [DISK_TIGHT_FREE_PERCENT, 'clear'],
    [DISK_TIGHT_FREE_PERCENT - 1, 'tight'],
    [DISK_CRITICAL_FREE_PERCENT, 'tight'],
    [DISK_CRITICAL_FREE_PERCENT - 1, 'critical'],
  ] as const)('%i%% free on bytes reads %s', (pct, verdict) => {
    expect(judgeDisk({ roots: [root('/tmp', pct, 90)] }, 'x').verdict).toBe(verdict);
  });

  it('the worst root is the device verdict, and a root that cannot be read is not a clear one', () => {
    const disk = judgeDisk(
      { roots: [root('/home/x/tmp', 90, 90), { root: '/tmp', refused: 'statvfs answered EIO' }] },
      'x',
    );
    expect(disk.verdict).toBe('unmeasurable');
    expect(disk.roots[1]).toMatchObject({ verdict: 'unmeasurable', axis: null });
    const worse = judgeDisk(
      { roots: [root('/a', 10, 90), { root: '/tmp', refused: 'statvfs answered EIO' }] },
      'x',
    );
    expect(worse.verdict).toBe('tight');
  });

  it('an axis with no stated total is not read as zero free', () => {
    const disk = judgeDisk(
      {
        roots: [{ root: '/btrfs', bytesFree: 50, bytesTotal: 100, inodesFree: 0, inodesTotal: 0 }],
      },
      'x',
    );
    expect(disk.roots[0]).toMatchObject({
      inodesFreePercent: null,
      verdict: 'clear',
      axis: 'bytes',
    });
    const none = judgeDisk(
      { roots: [{ root: '/x', bytesFree: 0, bytesTotal: 0, inodesFree: 0, inodesTotal: 0 }] },
      'x',
    );
    expect(none.verdict).toBe('unmeasurable');
  });

  it('a box that sends no report changes nothing stored and is acknowledged with nothing', () => {
    const read = heartbeatDisk(undefined, { id: 'd1' });
    expect(read).toEqual({ ack: {} });
    expect(heartbeatPatch({ disk: read.report }, NOW)).not.toHaveProperty('diskReport');
  });

  it.each([
    ['an empty picture', { roots: [] }, 'disk.roots'],
    [
      'more roots than a box reads',
      { roots: Array.from({ length: DISK_WIRE_ROOTS + 1 }, (_, i) => root(`/r${i}`, 50, 50)) },
      'disk.roots',
    ],
    ['a negative count', { roots: [{ ...root('/tmp', 50, 50), bytesFree: -1 }] }, 'disk.roots.0'],
    [
      'a root longer than the box clips to',
      { roots: [{ root: 'x'.repeat(DISK_TEXT_UNITS + 1), refused: 'no' }] },
      'disk.roots.0',
    ],
    ['an unknown key', { roots: [root('/tmp', 50, 50)], verdict: 'clear' }, 'disk'],
  ])('%s is refused by name in the ack and nothing is stored', (_, body, at) => {
    const read = heartbeatDisk(body, { id: 'd1' });
    expect(read.report).toBeUndefined();
    expect(read.ack).toMatchObject({ disk: { accepted: false } });
    const reason = (read.ack.disk as { reason: string }).reason;
    expect(reason.startsWith(at)).toBe(true);
  });

  it("a verdict is said in core's log once when it moves, at the level it earned, never per beat", () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const critical = { roots: [root('/tmp', 50, 2)] };
    const stored = heartbeatPatch({ disk: critical }, NOW).diskReport;
    heartbeatDisk(critical, {
      id: 'd1',
      diskReport: { roots: [root('/tmp', 50, 50)], receivedAt: 'x' },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      deviceId: 'd1',
      verdict: 'critical',
      was: 'clear',
    });
    heartbeatDisk(critical, { id: 'd1', diskReport: stored });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('a stored report core can no longer read is shown as never reported, not as clear', () => {
    const [row] = withDeviceDisk([{ id: 'd1', diskReport: { roots: 'x', receivedAt: 'y' } }]);
    expect(row?.disk).toBeNull();
  });
});
