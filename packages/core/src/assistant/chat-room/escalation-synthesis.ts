/**
 * The PM session is an advisor returning `{answer, followUp?}`; this parses that and runs ONE fresh
 * Bao-persona turn to author the reply the user sees. A proposed follow-up is OFFERED to the person
 * as Feedback to record once they agree (owner ruling 2026-10-08: a chat files no issue, and writes
 * nothing before the person confirms), so the relay turn runs with no tools.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type agentSessions as agentSessionsTable, projects } from '../../db/schema.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof } from '../../integrations/rocketchat/index.js';
import { logger } from '../../lib/logger.js';
import { webBaseUrl } from '../../lib/web-base-url.js';
import { type MessageRefusal, type MessageVerdict, refusalsOf } from '../../messaging/contract.js';
import { proven, wholeAgentText } from '../../messaging/proven.js';
import { withRepairs } from '../../messaging/repairs.js';
import { screenReplyAtDoor } from '../../messaging/reply-screen.js';
import { correctFalseClaims } from '../confab.js';
import { runExternalChatTurn } from '../external-chat.js';
import { ESCALATION_FALLBACK_REPLY } from './escalation.js';
import { rocketChatPersona } from './persona.js';
import type { RoomReplyMeta } from './room-replies.js';

type SessionRow = typeof agentSessionsTable.$inferSelect;

interface EscalationFollowUp {
  title: string;
  description: string;
  reason: string;
}

interface EscalationPayload {
  answer: string;
  followUp?: EscalationFollowUp;
}

const JSON_FENCE_RE = /```json\s*([\s\S]*?)```/gi;

export function parseEscalationPayload(text: string): EscalationPayload {
  const matches = [...text.matchAll(JSON_FENCE_RE)];
  const fence = matches[matches.length - 1]?.[1];
  if (!fence) return { answer: text };
  try {
    const parsed = JSON.parse(fence) as Record<string, unknown>;
    if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) return { answer: text };
    const payload: EscalationPayload = { answer: parsed.answer.trim() };
    const proposal = parsed.followUp;
    if (proposal && typeof proposal === 'object') {
      const p = proposal as Record<string, unknown>;
      if (
        typeof p.title === 'string' &&
        p.title.trim() &&
        typeof p.description === 'string' &&
        p.description.trim() &&
        typeof p.reason === 'string' &&
        p.reason.trim()
      ) {
        payload.followUp = {
          title: p.title.trim(),
          description: p.description.trim(),
          reason: p.reason.trim(),
        };
      }
    }
    return payload;
  } catch {
    return { answer: text };
  }
}

function buildSynthesisMessage(
  question: string,
  payload: EscalationPayload,
  askedBy: string,
): string {
  const lines = [
    `A teammate (PM) investigated this question from @${askedBy}: "${question}"`,
    `Their answer: "${payload.answer}"`,
    'Relay this to the user in your own voice, plainly, as the final answer — do NOT re-investigate or contradict it, the answer is authoritative.',
  ];
  if (payload.followUp) {
    lines.push(
      `The teammate also proposes a follow-up — "${payload.followUp.title}": ${payload.followUp.description} (why: ${payload.followUp.reason}). Offer to record it as Feedback: say in a sentence what you would record and ask whether to go ahead. Record nothing in this reply, and never call it an issue: a chat files no issue.`,
    );
  }
  return lines.join('\n');
}

interface EscalationRoute {
  slug: string;
  name: string;
}

async function resolveEscalationRoute(projectId: string): Promise<EscalationRoute | null> {
  const [proj] = await db
    .select({ slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return proj ?? null;
}

const EMPTY_SYNTHESIS = {
  rule: 'non-empty',
  why: 'empty synthesis reply',
  quote: null,
  shape: 'the synthesis carries text',
  example: 'The team has the answer and will reply here shortly.',
} as const;

const correctiveSynthesis = (refusals: readonly MessageRefusal[]): string =>
  `[SYSTEM CHECK — not from the user] Your previous answer cannot be sent as-is: ${refusals.map((r) => r.why).join('; ')}. Rewrite it now, keep only verified facts, and reply in the user's language.`;

export async function synthesizeViaBao(
  session: SessionRow,
  meta: RoomReplyMeta,
  payload: EscalationPayload,
): Promise<{ text: string; proof: ReplySendProof }> {
  const route = await resolveEscalationRoute(session.projectId);
  if (!route) return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
  if (!meta.principalUserId) {
    logger.error(
      { sessionId: session.id, rid: meta.rid },
      'rocketchat.escalation: the session stored no asker to act as; refusing synthesis',
    );
    return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
  }
  return synthesizeWith(session, meta, payload, route);
}

async function synthesizeWith(
  session: SessionRow,
  meta: RoomReplyMeta,
  payload: EscalationPayload,
  route: EscalationRoute,
): Promise<{ text: string; proof: ReplySendProof }> {
  const persona = rocketChatPersona(route.name, meta.askedByUsername, {
    projectSlug: route.slug,
    webBaseUrl: webBaseUrl(),
    botName: meta.botName,
  });
  const synthesise = (correction: string | null) =>
    runExternalChatTurn({
      projectId: session.projectId,
      adapter: 'rocketchat',
      message: correction ?? buildSynthesisMessage(meta.question, payload, meta.askedByUsername),
      persona,
      userKey: meta.askedByUsername || null,
    });

  const first = await synthesise(null);
  const calls = [...first.toolCalls];
  let result = { ...first, reply: correctFalseClaims(first.reply, calls).text };

  const outcome = await withRepairs('escalation-synthesis', [result.reply], {
    screen: async (segments): Promise<MessageVerdict> => {
      const text = (segments[0] ?? '').trim();
      if (!text) return { ok: false, refusals: [EMPTY_SYNTHESIS] };
      return screenReplyAtDoor('escalation-synthesis', {
        projectId: session.projectId,
        segments: [text],
        toolCalls: result.toolCalls,
        progress: result.progress,
      });
    },
    rewrite: async (verdict) => {
      logger.warn(
        { sessionId: session.id, rid: meta.rid, refusals: refusalsOf(verdict) },
        'rocketchat.escalation: synthesis failed the screen; one corrective retry',
      );
      const retried = await synthesise(correctiveSynthesis(refusalsOf(verdict)));
      calls.push(...retried.toolCalls);
      result = { ...retried, reply: correctFalseClaims(retried.reply, calls).text };
      return [result.reply];
    },
  });

  if (outcome.kind === 'exhausted') {
    logger.error(
      { sessionId: session.id, rid: meta.rid, refusals: refusalsOf(outcome.verdict) },
      'rocketchat.escalation: synthesis still failing after its repair; honest fallback',
    );
    return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
  }
  const text = result.reply.trim();
  const admitted = proven('escalation-synthesis', wholeAgentText(text), outcome.verdict);
  if (!admitted) {
    logger.error(
      { sessionId: session.id, rid: meta.rid },
      'rocketchat.escalation: the synthesis passed its screen and could not be admitted; honest fallback',
    );
    return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
  }
  return { text: admitted.text, proof: admitted };
}
