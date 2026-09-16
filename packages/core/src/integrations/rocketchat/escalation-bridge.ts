/**
 * ISS-675/ISS-687 — the escalation completion bridge. The PM session is an
 * advisor returning `{answer, issueProposal?}`; this parses that and runs ONE
 * fresh Bao-persona turn to author the reply the user sees, creating any
 * proposed follow-up issue under Bao's own authority.
 */

import { eq } from 'drizzle-orm';
import { runExternalChatTurn } from '../../assistant/external-chat.js';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { buildChatToolContext } from '../../assistant/tools/principal.js';
import { buildProjectToolset } from '../../assistant/tools/registry.js';
import { recordDeliveredReplyToVenue } from '../../conversations/transcript.js';
import { db } from '../../db/client.js';
import {
  type agentSessions as agentSessionsTable,
  organizations,
  projects,
} from '../../db/schema.js';
import { logger } from '../../logger.js';
import { type MessageVerdict, problemsOf } from '../../messaging/contract.js';
import { withRepairs } from '../../messaging/repairs.js';
import { screenReplyAtDoor } from '../../messaging/reply-screen.js';
import { webBaseUrl } from './connection-manager.js';
import { rocketChatVenueId } from './conversation-port.js';
import { ESCALATION_FALLBACK_REPLY } from './escalation.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof, sendFixedReply } from './outbound.js';
import { rocketChatPersona } from './persona.js';
import {
  claimRoomReplyDelivery,
  extractFinalAssistantText,
  type RoomReplyMeta,
  readRoomReplyMeta,
  resolveRoomPostAuth,
  roomStillBoundTo,
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

const EMPTY_SYNTHESIS = {
  rule: 'non-empty',
  why: 'empty synthesis reply',
  quote: null,
  shape: 'the synthesis carries text',
  example: 'The team has the answer and will reply here shortly.',
} as const;

const correctiveSynthesis = (problems: string[]): string =>
  `[SYSTEM CHECK — not from the user] Your previous answer cannot be sent as-is: ${problems.join('; ')}. Rewrite it now, keep only verified facts, and reply in the user's language.`;

async function synthesizeViaBao(
  session: SessionRow,
  meta: RoomReplyMeta,
  payload: EscalationPayload,
): Promise<{ text: string; proof: ReplySendProof }> {
  const route = await resolveEscalationRoute(session.projectId);
  if (!route) return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
  if (meta.shape === 'direct' && !meta.principalUserId) {
    logger.error(
      { sessionId: session.id, rid: meta.rid },
      'rocketchat.escalation: direct room stored no speaker principal; refusing synthesis',
    );
    return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
  }
  const principalUserId = meta.principalUserId ?? route.principalUserId;

  const persona = rocketChatPersona(route.name, meta.askedByUsername, {
    projectSlug: route.slug,
    webBaseUrl,
    botName: meta.botName,
  });
  const tools = payload.issueProposal
    ? buildProjectToolset(
        buildChatToolContext({
          userId: principalUserId,
          projectId: session.projectId,
          projectSlug: route.slug,
        }),
      )
    : undefined;

  const synthesise = (correction: string | null) =>
    runExternalChatTurn({
      projectId: session.projectId,
      adapter: 'rocketchat',
      message: correction ?? buildSynthesisMessage(meta.question, payload, meta.askedByUsername),
      tools,
      turnKind: tools ? 'agentic' : 'relay',
      persona,
      userKey: meta.askedByUsername || null,
    });

  let result = await synthesise(null);

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
        { sessionId: session.id, rid: meta.rid, problems: problemsOf(verdict) },
        'rocketchat.escalation: synthesis failed the screen; one corrective retry',
      );
      result = await synthesise(correctiveSynthesis(problemsOf(verdict)));
      return [result.reply];
    },
  });

  if (outcome.kind === 'exhausted') {
    logger.error(
      { sessionId: session.id, rid: meta.rid, problems: problemsOf(outcome.verdict) },
      'rocketchat.escalation: synthesis still failing after its repair; honest fallback',
    );
    return { text: ESCALATION_FALLBACK_REPLY(meta.botName), proof: FIXED_REPLY_CONSTANT };
  }
  return { text: result.reply.trim(), proof: { ok: true, problems: [] } };
}

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
