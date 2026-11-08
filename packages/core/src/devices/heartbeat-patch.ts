import { type SQL, sql } from 'drizzle-orm';
import { devices } from '../db/schema.js';
import { relayCapableRunner } from '../lib/relay-runner.js';
import { type BinaryReport, storedBinaryReport } from './binary-report.js';
import { type DiskReport, storedDiskReport } from './disk-report.js';
import { type GateReport, storedGateReport } from './gate-report.js';

interface HeartbeatReport {
  agentVersion?: string | undefined;
  agentCommit?: string | undefined;
  capabilities?: Record<string, unknown> | undefined;
  gate?: GateReport | undefined;
  binaries?: BinaryReport | undefined;
  disk?: DiskReport | undefined;
}

export interface DevicePatch {
  lastSeenAt: Date;
  relayRunnerAt?: SQL;
  agentVersion?: string;
  agentCommit?: string | null;
  capabilities?: Record<string, unknown>;
  gateReport?: unknown;
  binaryReport?: unknown;
  diskReport?: unknown;
}

/**
 * Version and commit are ONE identity and move together: keeping the commit a box
 * last reported would let a modified local build pass for the release it was built
 * from (ISS-1165). A heartbeat reporting no version changes neither.
 */
export function heartbeatPatch(report: HeartbeatReport, now: Date): DevicePatch {
  return {
    lastSeenAt: now,
    ...(report.agentVersion !== undefined
      ? { agentVersion: report.agentVersion, agentCommit: report.agentCommit ?? null }
      : {}),
    // a relay runner reported once latches the device for good (ISS-685): reporting an older
    // version after never hands it a relayed host's token
    ...(relayCapableRunner(report.agentVersion)
      ? {
          relayRunnerAt: sql`COALESCE(${devices.relayRunnerAt}, ${now.toISOString()}::timestamptz)`,
        }
      : {}),
    ...(report.capabilities !== undefined ? { capabilities: report.capabilities } : {}),
    ...(report.gate !== undefined ? { gateReport: storedGateReport(report.gate, now) } : {}),
    ...(report.binaries !== undefined
      ? { binaryReport: storedBinaryReport(report.binaries, now) }
      : {}),
    ...(report.disk !== undefined ? { diskReport: storedDiskReport(report.disk, now) } : {}),
  };
}
