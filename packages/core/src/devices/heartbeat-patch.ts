export interface HeartbeatReport {
  agentVersion?: string | undefined;
  agentCommit?: string | undefined;
  capabilities?: Record<string, unknown> | undefined;
}

export interface DevicePatch {
  lastSeenAt: Date;
  status: 'online';
  agentVersion?: string;
  agentCommit?: string | null;
  capabilities?: Record<string, unknown>;
}

/**
 * Version and commit are ONE identity and move together: keeping the commit a box
 * last reported would let a modified local build pass for the release it was built
 * from (ISS-1165). A heartbeat reporting no version at all changes neither.
 */
export function heartbeatPatch(report: HeartbeatReport, now: Date): DevicePatch {
  return {
    lastSeenAt: now,
    status: 'online',
    ...(report.agentVersion !== undefined
      ? { agentVersion: report.agentVersion, agentCommit: report.agentCommit ?? null }
      : {}),
    ...(report.capabilities !== undefined ? { capabilities: report.capabilities } : {}),
  };
}
