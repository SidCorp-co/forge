/**
 * Another box for a turn whose runner failed on infrastructure.
 *
 * Split out of `conversation-agent.ts` for the size budget (ISS-1039). The seam
 * is the one the code already had: everything here runs AFTER a turn has gone
 * terminal and the bridge has claimed its delivery, and nothing in the dispatch
 * path calls into it.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type agentSessions, type MemberLens, projects } from '../db/schema.js';
import { findAvailableDeviceForProject } from '../lib/device-pool.js';
import { logger } from '../logger.js';
import { createChatSessionRow, dispatchChatTurn } from './chat-turn.js';
import {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  markSessionFailed,
  readConversationAgentMeta,
  TITLE_MAX,
} from './conversation-agent.js';
import { scheduleAck } from './conversation-agent-ack.js';

type SessionRow = typeof agentSessions.$inferSelect;

const MAX_FAILOVERS = 2;

export type ConversationAgentFailoverResult =
  | { ok: true; sessionId: string; deviceId: string }
  | {
      ok: false;
      status: 'not-a-conversation-turn' | 'exhausted' | 'no-device' | 'no-prompt' | 'error';
    };

export async function redispatchConversationAgentTurn(
  session: SessionRow,
): Promise<ConversationAgentFailoverResult> {
  const meta = readConversationAgentMeta(session.metadata);
  if (!meta) return { ok: false, status: 'not-a-conversation-turn' };

  const prior = meta.failover ?? { attempt: 0, triedDeviceIds: [] };
  const tried = Array.from(
    new Set([...(prior.triedDeviceIds ?? []), session.deviceId].filter((d): d is string => !!d)),
  );
  const attempt = (prior.attempt ?? 0) + 1;
  if (attempt > MAX_FAILOVERS) return { ok: false, status: 'exhausted' };

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const firstUser = messages.find(
    (m): m is { role: string; content: string } =>
      !!m &&
      (m as { role?: string }).role === 'user' &&
      typeof (m as { content?: unknown }).content === 'string',
  );
  if (!firstUser) return { ok: false, status: 'no-prompt' };

  const deviceId = await findAvailableDeviceForProject(session.projectId, {
    excludeDeviceIds: tried,
  });
  if (!deviceId) return { ok: false, status: 'no-device' };

  const [project] = await db
    .select({ id: projects.id, slug: projects.slug, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, session.projectId))
    .limit(1);
  if (!project) return { ok: false, status: 'error' };

  const priorMeta = (session.metadata as Record<string, unknown>) ?? {};
  const next: ConversationAgentMeta = {
    ...meta,
    claimedAt: null,
    deliveredAt: null,
    failure: null,
    failover: { attempt, triedDeviceIds: tried },
  };

  let retry: SessionRow;
  try {
    retry = await createChatSessionRow({
      projectId: session.projectId,
      userId: session.userId,
      title: session.title ?? `Chat: ${meta.question.slice(0, TITLE_MAX)}`,
      runKind: 'system',
      runMetadata: { source: 'conversation.agentTurn', conversationId: meta.conversationId },
      metadata: {
        [CONVERSATION_AGENT_MARKER]: next,
        ...(priorMeta.lensOverride ? { lensOverride: priorMeta.lensOverride } : {}),
        progressFacts: priorMeta.progressFacts ?? null,
      },
    });
  } catch (err) {
    logger.error(
      { err, failedSessionId: session.id, conversationId: meta.conversationId, attempt },
      'conversation-agent failover: retry session creation failed',
    );
    return { ok: false, status: 'error' };
  }

  try {
    const dispatched = await dispatchChatTurn({
      session: retry,
      project,
      client: { deviceId, isLocal: false, migrated: false },
      message: firstUser.content,
      ...(priorMeta.lensOverride
        ? { forceLenses: priorMeta.lensOverride as readonly MemberLens[] }
        : {}),
      broadcastEvent: 'agent-session.created',
    });
    logger.info(
      {
        failedSessionId: session.id,
        retrySessionId: dispatched.id,
        fromDeviceId: session.deviceId,
        toDeviceId: deviceId,
        failureReason: session.failureReason,
        attempt,
      },
      'conversation-agent failover: re-dispatched to another runner',
    );
    scheduleAck(dispatched.id, next);
    return { ok: true, sessionId: dispatched.id, deviceId };
  } catch (err) {
    logger.error(
      { err, failedSessionId: session.id, retrySessionId: retry.id, attempt },
      'conversation-agent failover: re-dispatch failed',
    );
    await markSessionFailed(retry, 'conversation-agent-failover', {
      ...next,
      claimedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      failure: meta.replies.failed,
    });
    return { ok: false, status: 'error' };
  }
}
