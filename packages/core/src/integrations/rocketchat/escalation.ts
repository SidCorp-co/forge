/**
 * ISS-675 — async escalation dispatcher. When the fast chat model calls
 * `escalate(question)`, `connection-manager.ts` hands the request here: dedup
 * against any in-flight escalation for the same room, resolve a runner device,
 * and dispatch a runner-hosted `system` agent-session (product lens, ISS-674)
 * with an escalation prompt. The session's reply is delivered later by the
 * completion bridge (`escalation-bridge.ts`), wired at every session-terminal
 * writer — this module never posts to the room itself.
 *
 * Reuses the exact chat-turn machinery `schedules/dispatch.ts` uses for
 * tick-driven system sessions (`resolveChatDevice` / `createChatSessionRow` /
 * `dispatchChatTurn`), including its "mark failed on WS-publish throw"
 * safety net — so a dead-on-arrival dispatch here behaves identically.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  resolveChatDevice,
} from '../../agent-sessions/chat-turn.js';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { applyKernelTransition } from '../../lifecycle/transition.js';
import { logger } from '../../logger.js';

const ESCALATION_TITLE_MAX = 80;

export const ESCALATION_ACK = (botName: string): string =>
  `${botName} đang tìm hiểu kỹ câu hỏi này, lát nữa quay lại trả lời bạn nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_DEDUP_REPLY = (botName: string): string =>
  `${botName} vẫn đang tìm hiểu câu hỏi trước đó cho phòng này, chờ thêm chút nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_NO_DEVICE_REPLY = (botName: string): string =>
  `Xin lỗi, hiện không có runner nào sẵn sàng để ${botName} tìm hiểu sâu câu hỏi này — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const ESCALATION_FALLBACK_REPLY = (botName: string): string =>
  `Xin lỗi, ${botName} chưa tìm ra câu trả lời chắc chắn cho câu hỏi này — bạn hỏi lại giúp mình nhé.`; // i18n-allow: user-facing channel reply

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

/**
 * DB-backed dedup: a `running` escalation session already tracks this room.
 * Instance-independent (unlike an in-memory Set) and self-clears the moment
 * the session goes terminal via ANY writer — the completion bridge wiring
 * guarantees a terminal transition always eventually lands.
 */
export async function hasInFlightEscalation(projectId: string, rid: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.metadata} -> 'escalation' ->> 'rid' = ${rid}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The prompt driving the runner-hosted escalation session. Curation rules are
 * spelled out explicitly (stable slug + dedup-by-reuse + no volatile numbers)
 * because the runner's `forge_knowledge` access has no client-side guardrail
 * of its own — the persona IS the enforcement here.
 *
 * ISS-687 — this session is an ADVISOR, not the one talking to the user: it
 * has no room-posting tool (structural — the bridge is the only path its
 * output reaches the room) and is instructed here to never call
 * `forge_issues` create itself. It hands back a structured payload; Bao
 * (`escalation-bridge.ts`) synthesizes the final reply and owns issue
 * creation.
 */
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

/**
 * Dedup → resolve device → create session → dispatch. Returns without a
 * session on dedup/no-device (nothing to bridge later); on a dispatch throw,
 * the session is marked `failed` via `applyKernelTransition` — which fires the
 * completion bridge exactly like any other terminal writer, so the room still
 * gets one honest fallback reply asynchronously.
 */
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
        set: { failureReason: 'ws-publish-failed' },
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
