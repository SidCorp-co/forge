/**
 * Another box for a turn whose runner failed on infrastructure. Everything here runs AFTER a turn
 * has gone terminal and the bridge has claimed its delivery; nothing in the dispatch path calls it.
 */

import { eq } from 'drizzle-orm';
import {
  firstUserMessageText,
  pickTurnCredentialDevice,
  resolveSessionAuthority,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { type agentSessions, type MemberLens, projects } from '../db/schema.js';
import { logger } from '../observability/logger.js';
import {
  createAgentSession,
  dispatchAgentTurn,
  markSessionFailed,
  TITLE_MAX,
} from './conversation-agent.js';
import {
  type ConversationAgentMeta,
  readConversationAgentMeta,
} from './conversation-agent-meta.js';

type SessionRow = typeof agentSessions.$inferSelect;

const MAX_FAILOVERS = 2;

export type ConversationAgentFailoverResult =
  | { ok: true; sessionId: string; deviceId: string }
  | {
      ok: false;
      status:
        | 'not-a-conversation-turn'
        | 'exhausted'
        | 'no-device'
        | 'no-prompt'
        | 'no-asker'
        | 'authority-refused'
        | 'error';
    };

type Refused = Extract<ConversationAgentFailoverResult, { ok: false }>;
interface Target {
  deviceId: string;
  authorised: Parameters<typeof dispatchAgentTurn>[0]['authorised'];
  project: { id: string; slug: string };
  firstUser: string;
  next: ConversationAgentMeta;
  userId: string;
}

/** The box, the authority and the marker a retry runs under, or why there is none. */
async function failoverTarget(
  session: SessionRow,
  meta: ConversationAgentMeta,
): Promise<Target | Refused> {
  const prior = meta.failover ?? { attempt: 0, triedDeviceIds: [] };
  const tried = Array.from(
    new Set([...(prior.triedDeviceIds ?? []), session.deviceId].filter((d): d is string => !!d)),
  );
  const attempt = (prior.attempt ?? 0) + 1;
  if (attempt > MAX_FAILOVERS) return { ok: false, status: 'exhausted' };

  const firstUser = firstUserMessageText(session.messages);
  if (!firstUser) return { ok: false, status: 'no-prompt' };

  if (!meta.asker) return { ok: false, status: 'no-asker' };
  const deviceId = await pickTurnCredentialDevice(session.projectId, tried);
  if (!deviceId) return { ok: false, status: 'no-device' };
  const authorised = await resolveSessionAuthority({
    asker: meta.asker,
    projectId: session.projectId,
    deviceId,
  });
  if (!authorised.ok) {
    logger.warn(
      { failedSessionId: session.id, code: authorised.refusal.code },
      'conversation-agent failover: the asker may no longer be acted as; not re-dispatched',
    );
    return { ok: false, status: 'authority-refused' };
  }

  const [project] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, session.projectId))
    .limit(1);
  if (!project) return { ok: false, status: 'error' };
  const next: ConversationAgentMeta = {
    ...meta,
    claimedAt: null,
    deliveredAt: null,
    failure: null,
    failover: { attempt, triedDeviceIds: tried },
  };
  return { deviceId, authorised, project, firstUser, next, userId: meta.asker.userId };
}

export async function redispatchConversationAgentTurn(
  session: SessionRow,
): Promise<ConversationAgentFailoverResult> {
  const meta = readConversationAgentMeta(session.metadata);
  if (!meta) return { ok: false, status: 'not-a-conversation-turn' };
  const target = await failoverTarget(session, meta);
  if ('ok' in target) return target;
  const { deviceId, authorised, project, firstUser, next, userId } = target;
  const attempt = next.failover?.attempt;
  const priorMeta = (session.metadata as Record<string, unknown>) ?? {};

  let retry: SessionRow;
  try {
    retry = await createAgentSession({
      projectId: session.projectId,
      userId,
      title: session.title ?? `Chat: ${meta.question.slice(0, TITLE_MAX)}`,
      parentSessionId: session.id,
      marker: next,
      lensOverride: priorMeta.lensOverride,
      progressFacts: priorMeta.progressFacts,
    });
  } catch (err) {
    logger.error(
      { err, failedSessionId: session.id, conversationId: meta.conversationId, attempt },
      'conversation-agent failover: retry session creation failed',
    );
    return { ok: false, status: 'error' };
  }

  try {
    const dispatched = await dispatchAgentTurn({
      session: retry,
      project,
      deviceId,
      authorised,
      marker: next,
      message: firstUser,
      ...(priorMeta.lensOverride
        ? { forceLenses: priorMeta.lensOverride as readonly MemberLens[] }
        : {}),
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
    return { ok: true, sessionId: dispatched.id, deviceId };
  } catch (err) {
    logger.error(
      { err, failedSessionId: session.id, retrySessionId: retry.id, attempt },
      'conversation-agent failover: re-dispatch failed',
    );
    const at = new Date().toISOString();
    await markSessionFailed(retry, 'conversation-agent-failover', {
      ...next,
      claimedAt: at,
      deliveredAt: at,
      failure: meta.replies.failed,
    });
    return { ok: false, status: 'error' };
  }
}
