import { describe, expect, it } from 'vitest';
import {
  BINARY_DETAIL_UNITS,
  BINARY_WIRE_MAX,
  heartbeatBinaries,
  withDeviceBinaries,
} from './binary-report.js';
import { heartbeatPatch } from './heartbeat-patch.js';

const NOW = new Date('2026-10-06T10:00:00Z');
const node = { name: 'node', detail: 'no `node` resolves on this daemon PATH' };

describe('a box names the pane binaries it cannot resolve on its heartbeat', () => {
  it('a readable report is stored with when core heard it, and the device read shows it', () => {
    const read = heartbeatBinaries({ missing: [node] }, 'd1');
    expect(read.ack).toEqual({ binaries: { accepted: true } });
    const patch = heartbeatPatch({ binaries: read.report }, NOW);
    expect(patch.binaryReport).toEqual({ missing: [node], receivedAt: NOW.toISOString() });
    const [row] = withDeviceBinaries([{ id: 'd1', binaryReport: patch.binaryReport }]);
    expect(row).toEqual({
      id: 'd1',
      binaries: { missing: [node], receivedAt: NOW.toISOString() },
    });
  });

  it('an empty list is the box saying everything resolves, and replaces an older miss', () => {
    const read = heartbeatBinaries({ missing: [] }, 'd1');
    expect(heartbeatPatch({ binaries: read.report }, NOW).binaryReport).toEqual({
      missing: [],
      receivedAt: NOW.toISOString(),
    });
  });

  it('a box that sends no report changes nothing stored and is acknowledged with nothing', () => {
    const read = heartbeatBinaries(undefined, 'd1');
    expect(read).toEqual({ ack: {} });
    expect(heartbeatPatch({ binaries: read.report }, NOW)).not.toHaveProperty('binaryReport');
  });

  it.each([
    [
      'a list past the bound',
      { missing: Array(BINARY_WIRE_MAX + 1).fill(node) },
      'binaries.missing',
    ],
    [
      'a detail past the bound',
      { missing: [{ name: 'node', detail: 'x'.repeat(BINARY_DETAIL_UNITS + 1) }] },
      'binaries.missing.0.detail',
    ],
    ['an entry with no name', { missing: [{ name: ' ', detail: 'd' }] }, 'binaries.missing.0.name'],
    ['a field core does not know', { missing: [], extra: 1 }, 'binaries'],
    ['not an object', 'node', 'binaries'],
  ])('%s is refused by name in the ack and stores nothing', (_, sent, at) => {
    const read = heartbeatBinaries(sent, 'd1');
    expect(read.report).toBeUndefined();
    const ack = read.ack.binaries as { accepted: boolean; reason: string };
    expect(ack.accepted).toBe(false);
    expect(ack.reason.startsWith(`${at}:`)).toBe(true);
  });

  it('a stored report core can no longer read shows as never reported, not as all resolving', () => {
    const [bad] = withDeviceBinaries([{ binaryReport: { missing: 'node', receivedAt: 'x' } }]);
    expect(bad?.binaries).toBeNull();
    const [unstamped] = withDeviceBinaries([{ binaryReport: { missing: [] } }]);
    expect(unstamped?.binaries).toBeNull();
    const [never] = withDeviceBinaries([{ binaryReport: null }]);
    expect(never?.binaries).toBeNull();
  });
});
