export interface HeartbeatReport {
  agentVersion?: string | undefined;
  agentCommit?: string | undefined;
  capabilities?: Record<string, unknown> | undefined;
}

export interface DevicePatch {
  lastSeenAt: Date;
  status: 'online';
  agentVersion?: string;
  agentCommit?: string;
  capabilities?: Record<string, unknown>;
}

/**
 * A field the box did not send is left out rather than written as null: an older
 * binary sends no commit, and clearing the stored one would lose the last thing
 * known about that box rather than report that it said nothing (ISS-1165).
 */
export function heartbeatPatch(report: HeartbeatReport, now: Date): DevicePatch {
  return {
    lastSeenAt: now,
    status: 'online',
    ...(report.agentVersion !== undefined ? { agentVersion: report.agentVersion } : {}),
    ...(report.agentCommit !== undefined ? { agentCommit: report.agentCommit } : {}),
    ...(report.capabilities !== undefined ? { capabilities: report.capabilities } : {}),
  };
}
