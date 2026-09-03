/**
 * ISS-675 — async escalation dispatcher, reached when the fast chat model
 * calls `escalate(question)`. Dedup, resolve a runner, dispatch a `system`
 * session; the reply is delivered later by `escalation-bridge.ts`.
 */
// cm:guard this module never posts to the room itself — the bridge is the only path its output reaches a channel

import { eq } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  resolveChatDevice,
} from '../../agent-sessions/chat-turn.js';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { applyKernelTransition } from '../../lifecycle/transition.js';
import { logger } from '../../logger.js';
import { hasInFlightRoomSession } from './room-delivery.js';

const ESCALATION_TITLE_MAX = 80;

export const ESCALATION_ACK = (botName: string): string =>
  `${botName} đang tìm hiểu kỹ câu hỏi này, lát nữa quay lại trả lời bạn nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_DEDUP_REPLY = (botName: string): string =>
  `${botName} vẫn đang tìm hiểu câu hỏi trước đó cho phòng này, chờ thêm chút nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_NO_DEVICE_REPLY = (botName: string): string =>
  `Xin lỗi, hiện không có runner nào sẵn sàng để ${botName} tìm hiểu sâu câu hỏi này — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

// cm:why ISS-818 — states WHY (figures unreconciled), not a bare "couldn't verify" that reads as "didn't understand you" and sends the user off to rephrase
export const ESCALATION_FALLBACK_REPLY = (botName: string): string =>
  `Xin lỗi, ${botName} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export interface StartEscalationArgs {
  projectId: string;
  project: { id: string; slug: string; repoPath: string | null };
  connectionId: string;
  rid: string;
  tmid?: string | undefined;
  botName: string;
  question: string;
  askedByUsername?: string | undefined;
}

export type StartEscalationResult =
  | { started: true; sessionId: string }
  | { started: false; reason: 'deduped' | 'no-device' | 'dispatch-failed' };

export function hasInFlightEscalation(projectId: string, rid: string): Promise<boolean> {
  return hasInFlightRoomSession(projectId, rid, 'escalation');
}

// cm:guard the knowledge-curation rules are spelled out IN the prompt because the runner's forge_knowledge access has no client-side guardrail — this text is the only enforcement
// cm:guard ISS-687 — this session is an ADVISOR: it must never be told to post to the room or call forge_issues create, because Bao (escalation-bridge.ts) owns the user-facing reply and issue creation
export function buildEscalationPrompt(question: string): string {
  return [
    'A teammate asked a question in Rocket.Chat that the fast assistant could not answer from existing project knowledge:',
    `"${question}"`,
    '',
    'Investigate the repository and this Forge project to answer it correctly. Then:',
    '1. Upsert your durable understanding into `forge_knowledge` — a stable kebab-case slug; if a similar topic already has an entry, REUSE its slug (upsert/dedup, do not create a near-duplicate); pick an appropriate `kind` and `confidence`. Write PRODUCT/BUSINESS understanding — how the feature/pipeline/mechanism works, the product map, interpretation rules. NEVER write volatile numbers (e.g. issue counts) into knowledge — those must stay a live query every time.',
    '2. You are an ADVISOR only: do NOT post a reply to the room and do NOT create an issue yourself (do not call `forge_issues` create). A teammate will deliver the final answer to the user and create any follow-up issue on your behalf.',
    '3. End your reply with EXACTLY ONE fenced JSON block and nothing after it:',
    '```json',
    '{ "answer": "<concise, business-language final answer for a non-technical stakeholder: no code, file paths, line numbers, raw pipeline-status tokens, or bare ISS-ids — plain language only>", "issueProposal": { "title": "<only if follow-up work is needed>", "description": "<what/where, expected vs actual>", "reason": "<why this needs an issue>" } }',
    '```',
    'Omit `issueProposal` entirely when no follow-up work is needed.',
  ].join('\n');
}

// cm:guard on a dispatch throw the session MUST be marked failed via applyKernelTransition — that fires the completion bridge like any other terminal writer, which is the only reason the room still gets one honest fallback
export async function startEscalation(args: StartEscalationArgs): Promise<StartEscalationResult> {
  if (await hasInFlightEscalation(args.projectId, args.rid)) {
    return { started: false, reason: 'deduped' };
  }

  const client = await resolveChatDevice(
    { projectId: args.projectId, deviceId: null, metadata: null },
    undefined,
  );
  if (!client.deviceId) {
    return { started: false, reason: 'no-device' };
  }

  const session = await createChatSessionRow({
    projectId: args.projectId,
    userId: null,
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
        deliveredAt: null,
      },
      lensOverride: ['product'],
    },
  });

  try {
    await dispatchChatTurn({
      session,
      project: args.project,
      client,
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
      await applyKernelTransition(db, {
        entity: 'session',
        to: 'failed',
        set: { failureReason: 'ws_publish_failed' },
        where: eq(agentSessions.id, session.id),
        fromStatus: session.status,
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
