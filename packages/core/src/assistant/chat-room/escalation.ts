/**
 * ISS-675 — async escalation dispatcher, reached when the fast chat model
 * calls `escalate(question)`. Dedup, resolve a runner, dispatch a `system`
 * session; the reply is delivered later by `escalation-bridge.ts`.
 */

import { eq } from 'drizzle-orm';
import type { SessionAsker } from '../../agent-sessions/index.js';
import {
  createChatSessionRow,
  dispatchChatTurn,
  mintSessionCredential,
  noTurnCredentialDeviceReason,
  pickTurnCredentialDevice,
  resolveSessionAuthority,
  transitionSessions,
} from '../../agent-sessions/index.js';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { hasInFlightRoomSession } from './room-replies.js';

const ESCALATION_TITLE_MAX = 80;

export const ESCALATION_ACK = (botName: string): string =>
  `${botName} đang tìm hiểu kỹ câu hỏi này, lát nữa quay lại trả lời bạn nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_DEDUP_REPLY = (botName: string): string =>
  `${botName} vẫn đang tìm hiểu câu hỏi trước đó cho phòng này, chờ thêm chút nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_NO_DEVICE_REPLY = (botName: string): string =>
  `Xin lỗi, hiện không có runner nào sẵn sàng để ${botName} tìm hiểu sâu câu hỏi này — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_FALLBACK_REPLY = (botName: string): string =>
  `Xin lỗi, ${botName} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

interface StartEscalationArgs {
  projectId: string;
  project: { id: string; slug: string };
  connectionId: string;
  rid: string;
  tmid?: string | undefined;
  botName: string;
  question: string;
  askedByUsername?: string | undefined;
  shape: 'direct' | 'group';
  /** The linked person who asked; the investigating session runs as them (ISS-17). */
  asker: SessionAsker;
}

type StartEscalationResult =
  | { started: true; sessionId: string }
  | {
      started: false;
      reason: 'deduped' | 'no-device' | 'runner-outdated' | 'authority-refused' | 'dispatch-failed';
      message?: string;
    };

// every frozen comment in this file is an `i18n-allow` lint pragma; deleting one to pay the drain would break the language gate instead of cleaning prose.
function hasInFlightEscalation(
  projectId: string,
  rid: string,
  tmid?: string | null | undefined,
): Promise<boolean> {
  return hasInFlightRoomSession(projectId, rid, 'escalation', tmid);
}

function buildEscalationPrompt(question: string): string {
  return [
    'A teammate asked a question in Rocket.Chat that the fast assistant could not answer from existing project knowledge:',
    `"${question}"`,
    '',
    'Investigate the repository and this Forge project to answer it correctly. Then:',
    '1. Upsert your durable understanding into project knowledge (`PUT /api/projects/:id/knowledge/:slug`) — a stable kebab-case slug; if a similar topic already has an entry, REUSE its slug (upsert/dedup, do not create a near-duplicate); pick an appropriate `kind` and `confidence`. Write PRODUCT/BUSINESS understanding — how the feature/pipeline/mechanism works, the product map, interpretation rules. NEVER write volatile numbers (e.g. issue counts) into knowledge — those must stay a live query every time.',
    '2. You are an ADVISOR only: do NOT post a reply to the room and do NOT create an issue yourself (no `forge new`, no `POST /api/projects/:id/issues`). A teammate will deliver the final answer to the user and create any follow-up issue on your behalf.',
    '3. End your reply with EXACTLY ONE fenced JSON block and nothing after it:',
    '```json',
    '{ "answer": "<concise, business-language final answer for a non-technical stakeholder: no code, file paths, line numbers, raw pipeline-status tokens, or bare ISS-ids — plain language only>", "issueProposal": { "title": "<only if follow-up work is needed>", "description": "<what/where, expected vs actual>", "reason": "<why this needs an issue>" } }',
    '```',
    'Omit `issueProposal` entirely when no follow-up work is needed.',
  ].join('\n');
}

export async function startEscalation(args: StartEscalationArgs): Promise<StartEscalationResult> {
  if (await hasInFlightEscalation(args.projectId, args.rid, args.tmid)) {
    return { started: false, reason: 'deduped' };
  }

  const deviceId = await pickTurnCredentialDevice(args.projectId);
  if (!deviceId) {
    return { started: false, reason: await noTurnCredentialDeviceReason(args.projectId) };
  }
  const asker = { userId: args.asker.userId, viaTokenId: args.asker.viaTokenId };
  const authorised = await resolveSessionAuthority({ asker, projectId: args.projectId, deviceId });
  if (!authorised.ok) {
    return { started: false, reason: 'authority-refused', message: authorised.refusal.message };
  }

  const session = await createChatSessionRow({
    projectId: args.projectId,
    userId: asker.userId,
    title: `Escalation: ${args.question.slice(0, ESCALATION_TITLE_MAX)}`,
    runKind: 'system',
    runMetadata: { source: 'rocketchat.escalation', rid: args.rid },
    metadata: {
      escalation: {
        connectionId: args.connectionId,
        rid: args.rid,
        tmid: args.tmid ?? null,
        botName: args.botName,
        askedByUsername: args.askedByUsername ?? null,
        question: args.question,
        shape: args.shape,
        principalUserId: asker.userId,
        principalTokenId: asker.viaTokenId,
        deliveredAt: null,
      },
      lensOverride: ['product'],
    },
  });

  try {
    await dispatchChatTurn({
      session,
      project: args.project,
      client: { deviceId, isLocal: false, migrated: false },
      credential: await mintSessionCredential({
        sessionId: session.id,
        deviceId,
        value: authorised.value,
      }),
      message: buildEscalationPrompt(args.question),
      forceLenses: ['product'],
      broadcastEvent: 'agent-session.created',
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: args.rid },
      'rocketchat.escalation: chat-turn dispatch failed',
    );
    try {
      await transitionSessions(db, {
        to: 'failed',
        set: { failureReason: 'ws_publish_failed' },
        where: eq(agentSessions.id, session.id),
        reason: 'ws-publish-failed',
        actor: { type: 'system' },
        source: 'rocketchat.escalation',
      });
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, sessionId: session.id },
        'rocketchat.escalation: failed to mark session failed after dispatch failure',
      );
    }
    return { started: false, reason: 'dispatch-failed' };
  }

  return { started: true, sessionId: session.id };
}
