import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type agentSessions, devices } from '../db/schema.js';
import {
  findAvailableDeviceForProject,
  findChatCapableDeviceForProject,
} from '../lib/device-pool.js';
import { agentSessionsPorts } from './ports.js';
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
      ? 'No online Claude client for this project. Bring a chat-capable runner online, then try again.'
      : scope === 'picked'
        ? 'The selected runner is offline or not chat-capable for this project. Pick another runner, choose Auto, or bring it online, then try again.'
        : 'No online Claude client for this session. Bring its runner online, then try again.',
  );

/** What a box's heartbeat declares when it runs a session core marks `confined` holding only its turn token. */
export const CONFINED_CHAT_CAPABILITY = 'confinedChat';

/**
 * A chat door's turn is refused by name on a box that cannot confine it, before anything is
 * written: run unconfined, its shell reads the box's other credentials — the checkout's
 * workspace token, the holder's stored PAT — and files with those what its own token may not.
 */
export async function requireConfiningBox(deviceId: string): Promise<void> {
  const [box] = await db
    .select({ name: devices.name, capabilities: devices.capabilities })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  const declared = (box?.capabilities ?? {}) as Record<string, unknown>;
  if (declared[CONFINED_CHAT_CAPABILITY] === true) return;
  const said = declared.confinedChatUnavailable;
  const why =
    typeof said === 'string' && said.trim()
      ? said.trim()
      : 'its forge-runner predates confining a chat session — update it on the box (`forge-runner update`)';
  throw refuseSession(
    'BOX_CANNOT_CONFINE_CHAT',
    `A chat session holds only its own turn credential, and the runner box ${box?.name ?? deviceId} cannot confine one, so nothing was dispatched: ${why}.`,
  );
}

/** A turn is refused by name when no socket reads its box's room: nobody would take the frame. */
export function requireListeningBox(deviceId: string): void {
  if (!agentSessionsPorts().boxIsListening(deviceId)) throw noClaudeClient('session');
}

export interface ChatClient {
  /** The runner device the turn goes to; null when none is online. */
  deviceId: string | null;
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
  overrideDeviceId?: string | null,
  /** Only a box whose heartbeat declared this capability `true` is picked. */
  requireCapability?: string,
): Promise<ChatClient> {
  const need = requireCapability ? { requireCapability } : {};
  const pinned =
    ((session.metadata ?? {}) as { deviceId?: string }).deviceId ?? session.deviceId ?? null;
  if (overrideDeviceId) {
    const picked = await findChatCapableDeviceForProject(session.projectId, overrideDeviceId, {
      allowLimited: true,
      ...need,
    });
    if (!picked) return { deviceId: null, migrated: false };
    return { deviceId: picked, migrated: !!pinned && picked !== pinned };
  }
  if (pinned) {
    const capable = await findChatCapableDeviceForProject(session.projectId, pinned, need);
    if (capable) return { deviceId: capable, migrated: false };
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
        return { deviceId: pinned, migrated: false };
    }
  }
  const deviceId = await findAvailableDeviceForProject(session.projectId, need);
  // Migration = we had a pin but could not honour it and landed on another live
  // device. A pinless session is a true cold start, not a migration.
  const migrated = !!pinned && !!deviceId && deviceId !== pinned;
  return { deviceId, migrated };
}
