/**
 * The escalation completion bridge: posts the answer a PM session returned into the room it
 * was escalated from, once, through the synthesis turn in `escalation-synthesis.ts`.
 */

import { recordDeliveredReplyToVenue } from '../../conversations/index.js';
import type { agentSessions as agentSessionsTable } from '../../db/schema.js';
import {
  FIXED_REPLY_CONSTANT,
  namespaceFromServerUrl,
  type ReplySendProof,
  resolveRoomPostAuth,
  roomStillBoundTo,
  sendFixedReply,
} from '../../integrations/rocketchat/index.js';
import { logger } from '../../lib/logger.js';
import { ESCALATION_FALLBACK_REPLY } from './escalation.js';
import { parseEscalationPayload, synthesizeViaBao } from './escalation-synthesis.js';
import { rocketChatVenueId } from './port.js';
import {
  claimRoomReplyDelivery,
  extractFinalAssistantText,
  type RoomReplyMeta,
  readRoomReplyMeta,
} from './room-replies.js';

type SessionRow = typeof agentSessionsTable.$inferSelect;

export async function deliverEscalationReplyOnce(session: SessionRow): Promise<void> {
  const meta = readRoomReplyMeta(session.metadata, 'escalation');
  if (!meta) return;
  if (meta.deliveredAt) return;
  const bound = await roomStillBoundTo({
    connectionId: meta.connectionId,
    projectId: session.projectId,
    rid: meta.rid,
  });
  if (!bound) {
    await claimRoomReplyDelivery(session, 'escalation');
    logger.error(
      { sessionId: session.id, rid: meta.rid, projectId: session.projectId },
      'rocketchat.escalation-bridge: the room is no longer bound to this project; the answer is not posted',
    );
    return;
  }
  if (!(await claimRoomReplyDelivery(session, 'escalation'))) return;

  const auth = await resolveRoomPostAuth(meta.connectionId, {
    sessionId: session.id,
    source: 'rocketchat.escalation-bridge',
  });
  if (!auth) return;

  const finalText =
    session.status === 'completed' ? extractFinalAssistantText(session.messages) : null;
  let reply: string;
  let proof: ReplySendProof = FIXED_REPLY_CONSTANT;
  if (!finalText) {
    reply = ESCALATION_FALLBACK_REPLY(meta.botName);
  } else {
    const payload = parseEscalationPayload(finalText);
    try {
      const synthesized = await synthesizeViaBao(session, meta, payload);
      reply = synthesized.text;
      proof = synthesized.proof;
    } catch (err) {
      logger.error(
        { err, sessionId: session.id, rid: meta.rid },
        'rocketchat.escalation-bridge: Bao synthesis turn failed',
      );
      reply = ESCALATION_FALLBACK_REPLY(meta.botName);
    }
  }

  if (
    !(await roomStillBoundTo({
      connectionId: meta.connectionId,
      projectId: session.projectId,
      rid: meta.rid,
    }))
  ) {
    logger.error(
      { sessionId: session.id, rid: meta.rid, projectId: session.projectId },
      'rocketchat.escalation-bridge: the room was rebound while this answer was prepared; the answer is not posted',
    );
    return;
  }

  try {
    const receipt = await sendFixedReply(
      { kind: 'rest', auth, rid: meta.rid, tmid: meta.tmid ?? undefined },
      reply,
      proof,
    );
    await recordInRoomTranscript(auth.serverUrl, session.projectId, meta, reply, receipt);
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: meta.rid },
      'rocketchat.escalation-bridge: chat.postMessage failed',
    );
  }
}

/**
 * The room saw this answer, so the room's transcript holds it.
 */
async function recordInRoomTranscript(
  serverUrl: string,
  projectId: string,
  meta: RoomReplyMeta,
  reply: string,
  receipt: { messageId: string | null },
): Promise<void> {
  const namespace = namespaceFromServerUrl(serverUrl);
  if (!namespace) return;
  await recordDeliveredReplyToVenue({
    adapter: 'rocketchat',
    externalId: rocketChatVenueId(namespace, meta.rid, meta.tmid),
    projectId,
    text: reply,
    receipt,
  });
}
