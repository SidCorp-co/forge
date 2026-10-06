/**
 * What the filesystems a box writes its runs' scratch into have left, and what that means. The box
 * reads both axes per root (`runner-workspace/src/headroom.rs`) and reports them on the heartbeat;
 * core holds the thresholds and the verdict (ADR 0009: a disk's free space is the example of a fact
 * the box reports and core judges).
 */

import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { utf16String } from '../lib/utf16-string.js';

/** The box's own bounds: `runner-proto/src/disk.rs` `WIRE_ROOTS` and `TEXT_UNITS`. */
export const DISK_WIRE_ROOTS = 4;
export const DISK_TEXT_UNITS = 400;

/**
 * Under this free fraction on either axis a root is `critical`. A judging run's checkout on the box
 * ISS-1260 was raised from cost ~66,000 of the 1,048,576 inodes its `/tmp` holds (6.3%), so 8% is
 * the point at which at most one more fits.
 */
export const DISK_CRITICAL_FREE_PERCENT = 8;
/** Under this free fraction on either axis a root is `tight`: room for three such trees. */
export const DISK_TIGHT_FREE_PERCENT = 20;

const count = z.number().int().nonnegative();

const rootSchema = z.union([
  z
    .object({
      root: utf16String(DISK_TEXT_UNITS),
      bytesFree: count,
      bytesTotal: count,
      inodesFree: count,
      inodesTotal: count,
    })
    .strict(),
  z.object({ root: utf16String(DISK_TEXT_UNITS), refused: utf16String(DISK_TEXT_UNITS) }).strict(),
]);

const diskReportSchema = z
  .object({ roots: z.array(rootSchema).min(1).max(DISK_WIRE_ROOTS) })
  .strict();

export type DiskReport = z.infer<typeof diskReportSchema>;
type DiskRoot = z.infer<typeof rootSchema>;

export const diskVerdicts = ['clear', 'unmeasurable', 'tight', 'critical'] as const;
export type DiskVerdict = (typeof diskVerdicts)[number];

/** One root as every surface shows it: the box's figures and core's reading of them. */
export type DiskRootRead = DiskRoot & {
  bytesFreePercent: number | null;
  inodesFreePercent: number | null;
  verdict: DiskVerdict;
  /** The axis the verdict was taken on; `null` where nothing could be measured. */
  axis: 'bytes' | 'inodes' | null;
};

/** What every surface shows. `null` where this box has never reported its disk. */
export interface DeviceDisk {
  receivedAt: string;
  /** The worst root's verdict. */
  verdict: DiskVerdict;
  roots: DiskRootRead[];
  tightFreePercent: number;
  criticalFreePercent: number;
}

/**
 * The free fraction of one axis, or `null` where the filesystem states no total: btrfs and others
 * report no fixed inode table, and reading that as 0% free would put every such box permanently at
 * `critical`. More free than total is capped rather than believed.
 */
function freePercent(free: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.floor((free / total) * 100));
}

function judgeRoot(root: DiskRoot): DiskRootRead {
  if ('refused' in root) {
    return {
      ...root,
      bytesFreePercent: null,
      inodesFreePercent: null,
      verdict: 'unmeasurable',
      axis: null,
    };
  }
  const bytesFreePercent = freePercent(root.bytesFree, root.bytesTotal);
  const inodesFreePercent = freePercent(root.inodesFree, root.inodesTotal);
  const axes = [
    ['bytes', bytesFreePercent],
    ['inodes', inodesFreePercent],
  ] as const;
  let tightest: { axis: 'bytes' | 'inodes'; percent: number } | null = null;
  for (const [axis, percent] of axes) {
    if (percent === null) continue;
    if (tightest === null || percent < tightest.percent) tightest = { axis, percent };
  }
  const verdict: DiskVerdict =
    tightest === null
      ? 'unmeasurable'
      : tightest.percent < DISK_CRITICAL_FREE_PERCENT
        ? 'critical'
        : tightest.percent < DISK_TIGHT_FREE_PERCENT
          ? 'tight'
          : 'clear';
  return { ...root, bytesFreePercent, inodesFreePercent, verdict, axis: tightest?.axis ?? null };
}

const severity = (v: DiskVerdict) => diskVerdicts.indexOf(v);

/** A report as core reads it: each root judged, and the worst of them as the device's verdict. */
export function judgeDisk(report: DiskReport, receivedAt: string): DeviceDisk {
  const roots = report.roots.map(judgeRoot);
  const verdict = roots.reduce<DiskVerdict>(
    (worst, r) => (severity(r.verdict) > severity(worst) ? r.verdict : worst),
    'clear',
  );
  return {
    receivedAt,
    verdict,
    roots,
    tightFreePercent: DISK_TIGHT_FREE_PERCENT,
    criticalFreePercent: DISK_CRITICAL_FREE_PERCENT,
  };
}

export function storedDiskReport(
  report: DiskReport,
  now: Date,
): DiskReport & { receivedAt: string } {
  return { ...report, receivedAt: now.toISOString() };
}

/**
 * Liveness is the heartbeat's kernel job and this report rides along, so a report core cannot read
 * is refused by name in the response and nothing is stored, never a bad request that would take the
 * box offline with it, the rule `heartbeatGate` holds for the gate.
 *
 * A verdict that moved since the stored report is said in core's log at the level it earned, once
 * per change rather than once per beat: the box no longer says it, so this is where it is said.
 */
export function heartbeatDisk(
  disk: unknown,
  device: { id: string; diskReport?: unknown },
): { report?: DiskReport; ack: Record<string, unknown> } {
  if (disk === undefined) return { ack: {} };
  const parsed = diskReportSchema.safeParse(disk);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.length ? `disk.${first.path.join('.')}` : 'disk';
    const reason = `${at}: ${first?.message ?? 'not a disk report core can read'}`;
    logger.warn(
      { deviceId: device.id, reason },
      'heartbeat: this box sent a disk report core cannot read, so nothing was stored',
    );
    return { ack: { disk: { accepted: false, reason } } };
  }
  const now = judgeDisk(parsed.data, '');
  const was = readDeviceDisk(device.diskReport)?.verdict ?? null;
  if (now.verdict !== was) sayDiskVerdict(device.id, now, was);
  return { report: parsed.data, ack: { disk: { accepted: true } } };
}

function sayDiskVerdict(deviceId: string, disk: DeviceDisk, was: DiskVerdict | null) {
  const roots = disk.roots.map((r) => ({
    root: r.root,
    verdict: r.verdict,
    axis: r.axis,
    bytesFreePercent: r.bytesFreePercent,
    inodesFreePercent: r.inodesFreePercent,
    ...('refused' in r ? { refused: r.refused } : {}),
  }));
  const fields = { deviceId, verdict: disk.verdict, was, roots };
  if (disk.verdict === 'critical') {
    logger.error(
      fields,
      `disk: this box's scratch is under ${DISK_CRITICAL_FREE_PERCENT}% free; a run that cannot create a file fails in whatever way its own tooling fails, and the worktree sweep will not reclaim it`,
    );
  } else if (disk.verdict === 'tight' || disk.verdict === 'unmeasurable') {
    logger.warn(fields, `disk: this box's scratch reads ${disk.verdict}`);
  } else if (was !== null) {
    logger.info(fields, "disk: this box's scratch is clear on both axes again");
  }
}

export function withDeviceDisk<T extends { diskReport?: unknown }>(
  rows: T[],
): Array<Omit<T, 'diskReport'> & { disk: DeviceDisk | null }> {
  return rows.map(({ diskReport, ...row }) => ({ ...row, disk: readDeviceDisk(diskReport) }));
}

function readDeviceDisk(stored: unknown): DeviceDisk | null {
  if (stored === null || typeof stored !== 'object') return null;
  const { receivedAt, ...report } = stored as { receivedAt?: unknown };
  const parsed = diskReportSchema.safeParse(report);
  if (!parsed.success || typeof receivedAt !== 'string') return null;
  return judgeDisk(parsed.data, receivedAt);
}
