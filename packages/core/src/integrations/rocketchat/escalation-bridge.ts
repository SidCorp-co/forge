/**
 * ISS-675/ISS-687 — the completion bridge: fires when an escalation session
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
 *
 * ISS-687 refinement: the PM session (`escalation.ts`) is an advisor only —
 * it returns a structured `{answer, issueProposal?}` payload instead of text
 * meant for the room. This bridge no longer posts that text directly; it
 * parses the payload and runs ONE fresh Bao-persona synthesis turn
 * (`synthesizeViaBao`) to author the reply the user actually sees, creating
 * any proposed follow-up issue via Bao's own create authority.
 */

import { scrubLogText } from '@forge/observability';
import { and, eq, sql } from 'drizzle-orm';
import { runExternalChatTurn } from '../../chat/external-chat.js';
import { buildChatToolContext } from '../../chat/tools/principal.js';
import { buildProjectToolset } from '../../chat/tools/registry.js';
import { db } from '../../db/client.js';
import {
  agentSessions,
  type agentSessions as agentSessionsTable,
  organizations,
  projects,
} from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import { rocketChatPersona, webBaseUrl } from './connection-manager.js';
import { ESCALATION_FALLBACK_REPLY } from './escalation.js';
import { screenStakeholderReply } from './reply-screen.js';
import { postRoomMessage } from './rest-client.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

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

interface EscalationMeta {
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
  askedByUsername: string;
  question: string;
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
    question: typeof e.question === 'string' ? e.question : '',
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

const JSON_FENCE_RE = /```json\s*([\s\S]*?)```/gi;

/**
 * Parse the PM session's structured advisory payload out of its final
 * assistant text — the LAST fenced ```json block wins (a model may think out
 * loud before it). Never throws: a missing fence or malformed JSON just
 * degrades to a plain answer (the raw text), so a PM reply that forgets the
 * contract still delivers via Bao instead of being dropped.
 */
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

/**
 * Resolve the project + org-owner identity the Bao synthesis turn runs as —
 * mirrors `connection-manager.ts`'s `buildRoutes` (projects → organizations
 * `createdBy`). Returns null (never throws) on a missing row; the caller
 * treats that as a synthesis failure and falls back.
 */
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

/**
 * Synthesize the PM's structured advisory into Bao's persona voice — a FRESH
 * scoped turn, NOT a continuation of the room's in-memory `sessionByRid`
 * conversation: this bridge fires from session-terminal writers that don't
 * hold that map and may run on a different core instance, but the PM already
 * did the deep research, so Bao only needs the question + answer to relay it.
 * Any thrown error propagates to the caller, which falls back to the honest
 * fallback reply — the room must never go silent.
 */
async function synthesizeViaBao(
  session: SessionRow,
  meta: EscalationMeta,
  payload: EscalationPayload,
): Promise<string> {
  const route = await resolveEscalationRoute(session.projectId);
  if (!route) return ESCALATION_FALLBACK_REPLY(meta.botName);

  const persona = rocketChatPersona(route.name, meta.askedByUsername, {
    projectSlug: route.slug,
    webBaseUrl,
    botName: meta.botName,
  });
  // Only hand Bao the forge toolset when it actually needs to act (create the
  // proposed issue) — otherwise pass no tools at all, so
  // `runExternalChatTurn`'s `requireInitialToolUse` doesn't force a needless
  // call on a pure relay-the-answer turn.
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
    persona,
    userKey: meta.askedByUsername || null,
  });

  const verdict = result.reply.trim()
    ? await screenStakeholderReply(session.projectId, result.reply, result.toolCalls)
    : { ok: false, problems: ['empty synthesis reply'] };
  return verdict.ok ? result.reply : ESCALATION_FALLBACK_REPLY(meta.botName);
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
    const payload = parseEscalationPayload(finalText);
    try {
      reply = await synthesizeViaBao(session, meta, payload);
    } catch (err) {
      logger.error(
        { err, sessionId: session.id, rid: meta.rid },
        'rocketchat.escalation-bridge: Bao synthesis turn failed',
      );
      reply = ESCALATION_FALLBACK_REPLY(meta.botName);
    }
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
