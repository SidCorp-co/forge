/**
 * ISS-675 — the completion bridge: fires when an escalation session
 * (`metadata.escalation` set by `escalation.ts`) reaches a terminal status,
 * from EITHER of the two writers that can flip a session terminal —
 * `agent-sessions/routes.ts` PATCH `/:id` (the runner happy-path, a direct
 * `db.update`) and `lifecycle/transition.ts`'s `applyKernelTransition` (every
 * other terminal writer: sweeper timeout, cascade, cancel, dispatch-failure).
 * Missing either site would hang a class of escalations silent — see the
 * plan's risk note.
 *
 * `deliverEscalationReplyOnce` is idempotent via a CAS stamp
 * (`metadata.escalation.deliveredAt`), so it is safe to call from both sites
 * (or the same site twice) without a double post.
 */

import { scrubLogText } from '@forge/observability';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentSessions, type agentSessions as agentSessionsTable } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import { ESCALATION_FALLBACK_REPLY } from './escalation.js';
import { screenStakeholderReply } from './reply-screen.js';
import { postRoomMessage } from './rest-client.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

type SessionRow = typeof agentSessionsTable.$inferSelect;

interface EscalationMeta {
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
  askedByUsername: string;
  deliveredAt: string | null;
}

function readEscalationMeta(metadata: unknown): EscalationMeta | null {
  const esc = (metadata as { escalation?: unknown } | null)?.escalation;
  if (!esc || typeof esc !== 'object') return null;
  const e = esc as Record<string, unknown>;
  if (
    typeof e.connectionId !== 'string' ||
    typeof e.rid !== 'string' ||
    typeof e.botName !== 'string'
  ) {
    return null;
  }
  return {
    connectionId: e.connectionId,
    rid: e.rid,
    tmid: typeof e.tmid === 'string' ? e.tmid : null,
    botName: e.botName,
    askedByUsername: typeof e.askedByUsername === 'string' ? e.askedByUsername : '',
    deliveredAt: typeof e.deliveredAt === 'string' ? e.deliveredAt : null,
  };
}

/**
 * Last non-empty assistant turn in the session transcript. Two on-disk shapes
 * exist (see `turns-helpers.ts messageRoleToTurnRole`): the desktop/chat shape
 * carries `entry.role`, the CLI-runner shape carries `entry.type` with no
 * `role` — both are handled here since an escalation session is a runner
 * (CLI) session dispatched through the chat-turn path.
 */
export function extractFinalAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { role?: unknown; type?: unknown; content?: unknown };
    const isAssistant = e.role === 'assistant' || (e.role === undefined && e.type === 'assistant');
    if (!isAssistant) continue;
    if (typeof e.content === 'string' && e.content.trim().length > 0) return e.content.trim();
  }
  return null;
}

const MAX_REPLY_CHARS = 4500;

function clip(text: string): string {
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}… [truncated]` : text;
}

/**
 * Deliver an escalation session's final answer to its originating RocketChat
 * room/thread — exactly once. No-op when `session` is not an escalation
 * session, or the CAS stamp shows it was already delivered.
 */
export async function deliverEscalationReplyOnce(session: SessionRow): Promise<void> {
  const meta = readEscalationMeta(session.metadata);
  if (!meta) return;
  if (meta.deliveredAt) return;

  const prevMetadata = (session.metadata as Record<string, unknown>) ?? {};
  const prevEscalation = (prevMetadata.escalation as Record<string, unknown>) ?? {};
  const now = new Date().toISOString();
  const nextMetadata = {
    ...prevMetadata,
    escalation: { ...prevEscalation, deliveredAt: now },
  };

  // CAS: exactly one caller wins even if the PATCH /:id happy-path and the
  // applyKernelTransition sweeper/failure hook race on the same session.
  const claimed = await db
    .update(agentSessions)
    .set({ metadata: nextMetadata as never })
    .where(
      and(
        eq(agentSessions.id, session.id),
        sql`(${agentSessions.metadata} -> 'escalation' ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  if (claimed.length === 0) return;

  const connection = await findConnectionById(meta.connectionId);
  if (!connection) {
    logger.error(
      { sessionId: session.id, connectionId: meta.connectionId },
      'rocketchat.escalation-bridge: connection not found',
    );
    return;
  }
  const secrets = decryptConnectionSecrets<RocketChatSecrets>(connection);
  const config = (connection.config ?? {}) as RocketChatConfig;
  if (!config.serverUrl || !secrets.authToken || !secrets.userId) {
    logger.error(
      { sessionId: session.id, connectionId: meta.connectionId },
      'rocketchat.escalation-bridge: connection missing serverUrl/credentials',
    );
    return;
  }
  const auth = {
    serverUrl: config.serverUrl,
    authToken: secrets.authToken,
    userId: secrets.userId,
  };

  const finalText =
    session.status === 'completed' ? extractFinalAssistantText(session.messages) : null;
  let reply: string;
  if (!finalText) {
    reply = ESCALATION_FALLBACK_REPLY(meta.botName);
  } else {
    const verdict = await screenStakeholderReply(session.projectId, finalText, []);
    reply = verdict.ok ? finalText : ESCALATION_FALLBACK_REPLY(meta.botName);
  }

  const safe = scrubLogText(clip(reply), [auth.authToken]);
  try {
    await postRoomMessage(auth, meta.rid, safe, meta.tmid ?? undefined);
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: meta.rid },
      'rocketchat.escalation-bridge: chat.postMessage failed',
    );
  }
}
