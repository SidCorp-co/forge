import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, devices } from '../db/schema.js';
import {
  findAvailableDeviceForProject,
  findChatCapableDeviceForProject,
} from '../lib/device-pool.js';
import { openOneShotRun } from '../pipeline/index.js';
import { refuseSession } from './refusals.js';

type AgentSessionRow = typeof agentSessions.$inferSelect;

/**
 * The refusal a caller throws when a REMOTE chat turn has no online Claude client.
 * `scope` only changes the user-facing wording (a brand-new turn references the
 * project; a follow-up references the session) — same code `NO_CLAUDE_CLIENT`.
 */
export const noClaudeClient = (scope: 'project' | 'session' | 'picked') =>
  refuseSession(
    'NO_CLAUDE_CLIENT',
    scope === 'project'
      ? 'No online Claude client for this project. Open the desktop app or bring a chat-capable runner online, then try again.'
      : scope === 'picked'
        ? 'The selected runner is offline or not chat-capable for this project. Pick another runner, choose Auto, or bring it online, then try again.'
        : 'No online Claude client for this session. Open the desktop app or bring its runner online, then try again.',
  );

export interface ChatClient {
  /** Resolved runner device for a REMOTE turn; null when local, or none online. */
  deviceId: string | null;
  /** Desktop runs Claude locally — no device pick, no `agent:start` dispatch. */
  isLocal: boolean;
  /**
   * True when we had to pick a device OTHER than the session's existing pin
   * (the pin went offline/disabled). The Claude on-disk session (`--resume`
   * target) lives only on the OLD box, so a follow-up turn must NOT `--resume`
   * here — it cold-starts on the new device and rehydrates history from the DB
   * transcript instead. Undefined ≡ false (a brand-new session has no pin to
   * lose, so it is a genuine cold start, not a migration).
   */
  migrated?: boolean;
}

export async function resolveChatDevice(
  session: Pick<AgentSessionRow, 'projectId' | 'deviceId' | 'metadata'>,
  origin?: string | null,
  overrideDeviceId?: string | null,
  /** Only a box whose heartbeat declared this capability `true` is picked. */
  requireCapability?: string,
): Promise<ChatClient> {
  if (origin === 'desktop') return { deviceId: null, isLocal: true, migrated: false };
  const need = requireCapability ? { requireCapability } : {};
  const pinned =
    ((session.metadata ?? {}) as { deviceId?: string }).deviceId ?? session.deviceId ?? null;
  if (overrideDeviceId) {
    const picked = await findChatCapableDeviceForProject(session.projectId, overrideDeviceId, {
      allowLimited: true,
      ...need,
    });
    if (!picked) return { deviceId: null, isLocal: false, migrated: false };
    return { deviceId: picked, isLocal: false, migrated: !!pinned && picked !== pinned };
  }
  if (pinned) {
    const capable = await findChatCapableDeviceForProject(session.projectId, pinned, need);
    if (capable) return { deviceId: capable, isLocal: false, migrated: false };
    const liveButLimited = await findChatCapableDeviceForProject(session.projectId, pinned, {
      allowLimited: true,
      ...need,
    });
    if (!liveButLimited) {
      const [dev] = await db
        .select({
          status: devices.status,
          disabledAt: devices.disabledAt,
          capabilities: devices.capabilities,
        })
        .from(devices)
        .where(eq(devices.id, pinned))
        .limit(1);
      const declares =
        !requireCapability ||
        (dev?.capabilities as Record<string, unknown> | null)?.[requireCapability] === true;
      // A turned-off device is ignored even when online + pinned — fall through to
      // pick another available device (or report no client).
      if (dev?.status === 'online' && !dev.disabledAt && declares)
        return { deviceId: pinned, isLocal: false, migrated: false };
    }
  }
  const deviceId = await findAvailableDeviceForProject(session.projectId, need);
  // Migration = we had a pin but could not honour it and landed on another live
  // device. A pinless session is a true cold start, not a migration.
  const migrated = !!pinned && !!deviceId && deviceId !== pinned;
  return { deviceId, isLocal: false, migrated };
}

interface CreateChatSessionArgs {
  projectId: string;
  userId: string | null;
  title?: string | null;
  deviceId?: string | null;
  repoPath?: string | null;
  claudeSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** The session this one was cut from — a rerun's source, a failover's
   *  predecessor. Core's own record, never a caller's claim about a tree. */
  parentSessionId?: string | null;
  /** Run kind for the one-shot pipeline_run every session belongs to (ISS-101). */
  runKind?: 'interactive' | 'system';
  runMetadata?: Record<string, unknown>;
}

/**
 * Insert an EMPTY chat session row (no seed turn, status defaults to `idle`).
 * The first turn is delivered later through {@link dispatchChatTurn}, exactly
 * like a follow-up — that uniformity is what collapses "begin a chat" and
 * "continue a chat" into one dispatch path.
 */
export async function createChatSessionRow(args: CreateChatSessionArgs): Promise<AgentSessionRow> {
  const run = await openOneShotRun({
    projectId: args.projectId,
    kind: args.runKind ?? 'interactive',
    ...(args.runMetadata ? { metadata: args.runMetadata } : {}),
  });
  const metadata =
    args.runKind === 'system' ? { ...(args.metadata ?? {}), unattended: true } : args.metadata;
  const [row] = await db
    .insert(agentSessions)
    .values({
      projectId: args.projectId,
      userId: args.userId,
      deviceId: args.deviceId ?? null,
      pipelineRunId: run.id,
      title: args.title ?? null,
      repoPath: args.repoPath ?? null,
      claudeSessionId: args.claudeSessionId ?? null,
      kind: 'chat',
      parentSessionId: args.parentSessionId ?? null,
      metadata: (metadata ?? null) as never,
    })
    .returning();
  if (!row) throw new Error('agent_sessions: insert returned no row');
  return row;
}
