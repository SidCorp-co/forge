/**
 * ISS-675/ISS-687 — the escalation completion bridge. The PM session is an
 * advisor returning `{answer, issueProposal?}`; this parses that and runs ONE
 * fresh Bao-persona turn to author the reply the user sees, creating any
 * proposed follow-up issue under Bao's own authority.
 */
// cm:guard must be fired from BOTH terminal writers — agent-sessions/routes.ts PATCH (runner happy-path) and lifecycle/transition.ts (sweeper, cascade, cancel, dispatch-failure) — or a whole class of escalations hangs silent

import { eq } from 'drizzle-orm';
import { runExternalChatTurn } from '../../chat/external-chat.js';
import { buildChatToolContext } from '../../chat/tools/principal.js';
import { buildProjectToolset } from '../../chat/tools/registry.js';
import { db } from '../../db/client.js';
import {
  type agentSessions as agentSessionsTable,
  organizations,
  projects,
} from '../../db/schema.js';
import { logger } from '../../logger.js';
import { rocketChatPersona, webBaseUrl } from './connection-manager.js';
import { ESCALATION_FALLBACK_REPLY } from './escalation.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof, sendFixedReply } from './outbound.js';
import { screenStakeholderReply } from './reply-screen.js';
import {
  claimRoomReplyDelivery,
  extractFinalAssistantText,
  type RoomReplyMeta,
  readRoomReplyMeta,
  resolveRoomPostAuth,
} from './room-delivery.js';

type SessionRow = typeof agentSessionsTable.$inferSelect;

export interface EscalationIssueProposal {
  title: string;
  description: string;
  reason: string;
}

export interface EscalationPayload {
  answer: string;
  issueProposal?: EscalationIssueProposal;
}

const JSON_FENCE_RE = /```json\s*([\s\S]*?)```/gi;

// cm:guard the LAST fenced block wins (a model may think out loud first) and this must never throw — a missing fence or bad JSON degrades to the raw text, so a PM reply that forgot the contract still delivers instead of being dropped
export function parseEscalationPayload(text: string): EscalationPayload {
  const matches = [...text.matchAll(JSON_FENCE_RE)];
  const fence = matches[matches.length - 1]?.[1];
  if (!fence) return { answer: text };
  try {
    const parsed = JSON.parse(fence) as Record<string, unknown>;
    if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) return { answer: text };
    const payload: EscalationPayload = { answer: parsed.answer.trim() };
    const proposal = parsed.issueProposal;
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
        payload.issueProposal = {
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
  if (payload.issueProposal) {
    lines.push(
      `Also log this as a draft issue via forge_issues create — title "${payload.issueProposal.title}", description "${payload.issueProposal.description}" (reason: ${payload.issueProposal.reason}). If the tool reports a near-duplicate, comment on that existing issue instead. Then tell the user you've logged it.`,
    );
  }
  return lines.join('\n');
}

interface EscalationRoute {
  slug: string;
  name: string;
  principalUserId: string;
}

// cm:why the identity the Bao turn runs as, resolved the same way buildRoutes does it (projects -> organizations.createdBy); null on a missing row is a synthesis failure the caller falls back from
async function resolveEscalationRoute(projectId: string): Promise<EscalationRoute | null> {
  const [proj] = await db
    .select({ slug: projects.slug, name: projects.name, orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) return null;
  const [org] = await db
    .select({ createdBy: organizations.createdBy })
    .from(organizations)
    .where(eq(organizations.id, proj.orgId))
    .limit(1);
  if (!org?.createdBy) return null;
  return { slug: proj.slug, name: proj.name, principalUserId: org.createdBy };
}

// cm:guard a FRESH turn, never a continuation of the room's in-memory sessionByRid: this bridge fires from terminal writers that do not hold that map and may run on another core instance
async function synthesizeViaBao(
  session: SessionRow,
  meta: RoomReplyMeta,
  payload: EscalationPayload,
): Promise<{ text: string; proof: ReplySendProof }> {
  const route = await resolveEscalationRoute(session.projectId);
  if (!route) return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };

  const persona = rocketChatPersona(route.name, meta.askedByUsername, {
    projectSlug: route.slug,
    webBaseUrl,
    botName: meta.botName,
  });
  // cm:guard pass NO tools on a pure relay turn — runExternalChatTurn's requireInitialToolUse would otherwise force a needless call
  const tools = payload.issueProposal
    ? buildProjectToolset(
        buildChatToolContext({
          userId: route.principalUserId,
          projectId: session.projectId,
          projectSlug: route.slug,
        }),
      )
    : undefined;

  const result = await runExternalChatTurn({
    projectId: session.projectId,
    source: 'rocketchat',
    message: buildSynthesisMessage(meta.question, payload, meta.askedByUsername),
    tools,
    turnKind: tools ? 'agentic' : 'relay',
    persona,
    userKey: meta.askedByUsername || null,
  });

  const verdict = result.reply.trim()
    ? await screenStakeholderReply(
        session.projectId,
        result.reply,
        result.toolCalls,
        result.progress,
      )
    : { ok: false, problems: ['empty synthesis reply'] };
  return verdict.ok
    ? { text: result.reply, proof: { ok: true, problems: verdict.problems } }
    : { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
}

export async function deliverEscalationReplyOnce(session: SessionRow): Promise<void> {
  const meta = readRoomReplyMeta(session.metadata, 'escalation');
  if (!meta) return;
  if (meta.deliveredAt) return;
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

  try {
    await sendFixedReply(
      { kind: 'rest', auth, rid: meta.rid, tmid: meta.tmid ?? undefined },
      reply,
      proof,
    );
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: meta.rid },
      'rocketchat.escalation-bridge: chat.postMessage failed',
    );
  }
}
