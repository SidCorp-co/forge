import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, devices } from '../db/schema.js';
import { getLoopThresholds } from './ports.js';

export type DerivedAgentStatus = 'running' | 'queued' | 'completed' | 'failed' | 'cancelled' | null;

export interface HydratedAgentSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  title: string | null;
  // ISS-377 — live-agent detail on the issue page needs the runner/device, a
  // start anchor for elapsed time, and the session heartbeat for the
  // alive-vs-stale signal (vs the sweeper's ~3-min timeout). Purely additive;
  // list/search/detail all surface these now.
  deviceId: string | null;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
  pipelineRunId: string | null;
  claudeSessionId: string | null;
  deviceName: string | null;
  /** Alive while its heartbeat is newer than the loop monitor's heartbeat timeout. */
  heartbeat: SessionHeartbeat;
  /** Whether it resumed its group's Claude session or started fresh, and why. */
  continuity: SessionContinuity;
  freshReason: SessionFreshReason | null;
}

export type SessionHeartbeat = 'alive' | 'stale' | 'unknown';
export type SessionContinuity = 'resumed' | 'fresh' | 'unknown';
export type SessionFreshReason = 'first-in-group' | 'different-device' | 'prior-failed' | 'new-session';

function heartbeatOf(at: Date | null, now: number, timeoutMs: number): SessionHeartbeat {
  if (!at) return 'unknown';
  return now - at.getTime() <= timeoutMs ? 'alive' : 'stale';
}

const metaString = (meta: Record<string, unknown> | null, key: string): string | null => {
  const v = meta?.[key];
  return typeof v === 'string' && v.trim() ? v : null;
};

// Oldest first, each session reads against the last one of its group: the same Claude session is
// resumed; a different one is fresh, because the device moved, the prior failed, or neither.
function withContinuity(sessions: HydratedAgentSession[]): void {
  const startOf = (s: HydratedAgentSession) => (s.startedAt ?? s.createdAt).getTime();
  const last = new Map<string, { claude: string; deviceId: string | null; status: string }>();
  for (const s of [...sessions].sort((a, b) => startOf(a) - startOf(b))) {
    const group = metaString(s.metadata, 'sessionGroup');
    const claude = s.claudeSessionId;
    if (!group || !claude) continue;
    const prior = last.get(group);
    if (!prior) {
      s.continuity = 'fresh';
      s.freshReason = 'first-in-group';
    } else if (prior.claude === claude) {
      s.continuity = 'resumed';
    } else {
      s.continuity = 'fresh';
      s.freshReason =
        prior.deviceId !== s.deviceId
          ? 'different-device'
          : prior.status === 'failed'
            ? 'prior-failed'
            : 'new-session';
    }
    last.set(group, { claude, deviceId: s.deviceId, status: s.status });
  }
}

export interface HydratedAgentAttachment {
  agentSessions: HydratedAgentSession[];
  agentStatus: DerivedAgentStatus;
}

export function deriveAgentStatus(sessions: HydratedAgentSession[]): DerivedAgentStatus {
  if (sessions.length === 0) return null;
  if (sessions.some((s) => s.status === 'running')) return 'running';
  if (sessions.some((s) => s.status === 'queued')) return 'queued';
  for (const s of sessions) {
    if (s.status === 'failed') return 'failed';
    if (s.status === 'completed' || s.status === 'completed_via_recovery') return 'completed';
    if (s.status === 'cancelled') return 'cancelled';
  }
  return null;
}

// Fetch non-`idle` agent_sessions for the given issues within a project, then
// build a map of issueId → { agentSessions, agentStatus }. Sessions are linked
// via `metadata->>'issueId'` (the canonical link written by
// `jobs/agent-session-link.ts`).
export async function hydrateAgentSessionsForIssues(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, HydratedAgentAttachment>> {
  const map = new Map<string, HydratedAgentAttachment>();
  if (issueIds.length === 0) return map;

  const rows = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      metadata: agentSessions.metadata,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
      title: agentSessions.title,
      deviceId: agentSessions.deviceId,
      startedAt: agentSessions.startedAt,
      lastHeartbeatAt: agentSessions.lastHeartbeatAt,
      pipelineRunId: agentSessions.pipelineRunId,
      claudeSessionId: agentSessions.claudeSessionId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        ne(agentSessions.status, 'idle'),
        sql`${agentSessions.metadata}->>'issueId' IS NOT NULL`,
        inArray(sql<string>`${agentSessions.metadata}->>'issueId'`, [...issueIds]),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt));

  // ISS-411 — one batch lookup deviceId → name, shared across all sessions
  // (and reused below in the push loop). Empty when no session has a device.
  const deviceIds = [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => !!d))];
  const deviceNameById = new Map<string, string>();
  if (deviceIds.length > 0) {
    const deviceRows = await db
      .select({ id: devices.id, name: devices.name })
      .from(devices)
      .where(inArray(devices.id, deviceIds));
    for (const d of deviceRows) deviceNameById.set(d.id, d.name);
  }

  const now = Date.now();
  const { heartbeatMs } = getLoopThresholds();
  for (const r of rows) {
    const meta = (r.metadata as Record<string, unknown> | null) ?? null;
    const issueId = typeof meta?.issueId === 'string' ? (meta.issueId as string) : null;
    if (!issueId) continue;
    let bucket = map.get(issueId);
    if (!bucket) {
      bucket = { agentSessions: [], agentStatus: null };
      map.set(issueId, bucket);
    }
    bucket.agentSessions.push({
      id: r.id,
      status: r.status,
      metadata: meta,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      title: r.title,
      deviceId: r.deviceId,
      startedAt: r.startedAt,
      lastHeartbeatAt: r.lastHeartbeatAt,
      pipelineRunId: r.pipelineRunId,
      claudeSessionId: r.claudeSessionId,
      deviceName: r.deviceId ? (deviceNameById.get(r.deviceId) ?? null) : null,
      heartbeat: heartbeatOf(r.lastHeartbeatAt ?? r.updatedAt, now, heartbeatMs),
      continuity: 'unknown',
      freshReason: null,
    });
  }

  for (const bucket of map.values()) {
    withContinuity(bucket.agentSessions);
    bucket.agentStatus = deriveAgentStatus(bucket.agentSessions);
  }

  // Ensure all requested issueIds have an entry — caller can graft the empty
  // shape directly without null-checks. `agentStatus = null` is treated as
  // `idle` by the indicator.
  for (const id of issueIds) {
    if (!map.has(id)) {
      map.set(id, { agentSessions: [], agentStatus: null });
    }
  }

  return map;
}
