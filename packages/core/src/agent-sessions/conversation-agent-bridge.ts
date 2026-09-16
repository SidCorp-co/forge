/**
 * The completion bridge for a conversation turn a runner answered.
 *
 * ISS-727's bridge posted through Rocket.Chat's own REST client, re-read
 * Rocket.Chat's own bindings and spoke Rocket.Chat's own fallbacks. This one
 * holds a venue and asks that venue's transport, so the browser's socket and a
 * Rocket.Chat room are the same call. It runs NO synthesis turn: the session
 * already produced the final user-facing reply, so delivery screens it and
 * delivers it verbatim.
 */
// cm:guard fired from BOTH terminal writers through `terminal-effects.ts`'s one list — the runner's happy-path `PATCH /api/agent-sessions/:id` and `lifecycle/transition.ts` (sweeper, cascade, cancel, dispatch-failure) — or a whole class of replies hangs silent.

import { and, eq, sql } from 'drizzle-orm';
import { codeAuthored, conversationTransport, screened } from '../conversations/ports.js';
import { recordDeliveredReply } from '../conversations/transcript.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';
import { problemsOf } from '../messaging/contract.js';
import type { ProgressFacts } from '../messaging/facts.js';
import { withRepairs } from '../messaging/repairs.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { resolveFailureCause } from '../pipeline/failure-causes.js';
import {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  readConversationAgentMeta,
  redispatchConversationAgentTurn,
} from './conversation-agent.js';
import { messageRoleToTurnRole } from './turns-helpers.js';

type SessionRow = typeof agentSessions.$inferSelect;

/**
 * What the venue is told, and what the screen recorded about it.
 */
// cm:guard `failure` is what the SCREEN outcome was, not how the process exited: a session that ended `completed` and wrote nothing a person can be shown is a failure to whoever asked, and a session that ended `failed` after its answer was already delivered is not. The four states a screen reads are derived from this stamp and never from `agentSessions.status` alone (ISS-1039).
type Outcome = { text: string; problems: readonly string[]; failure: string | null };

// cm:guard three distinct meanings, do not collapse them: a snapshot screens against itself; `null` means the key IS present but its computation failed, which fails CLOSED; `'legacy-session'` (key absent entirely) is the only case that self-computes, and is named rather than `undefined` so a caller who merely forgot the argument cannot reach it (ISS-818).
function readProgressFacts(metadata: unknown): ProgressFacts | null | 'legacy-session' {
  const m = metadata as Record<string, unknown> | null;
  if (!m || !('progressFacts' in m)) return 'legacy-session';
  const pf = m.progressFacts;
  if (!pf || typeof pf !== 'object') return null;
  const p = pf as Record<string, unknown>;
  const keys = ['shipped', 'closedUnshipped', 'inFlight', 'remaining', 'total'] as const;
  if (keys.some((k) => typeof p[k] !== 'number')) return null;
  return {
    shipped: p.shipped as number,
    closedUnshipped: p.closedUnshipped as number,
    inFlight: p.inFlight as number,
    remaining: p.remaining as number,
    total: p.total as number,
  };
}

// cm:why one-shot dispatch means the whole transcript IS the turn the claimed-creation check judges, so there is no "final turn" to isolate — unlike the escalation bridge, whose reply comes from a separate synthesis turn.
function extractToolCalls(messages: unknown): Array<{ name: string; arguments: string }> {
  if (!Array.isArray(messages)) return [];
  const calls: Array<{ name: string; arguments: string }> = [];
  for (const entry of messages) {
    const toolCalls = (entry as { toolCalls?: unknown } | null)?.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const t = tc as { name?: unknown; input?: unknown } | null;
      if (!t || typeof t.name !== 'string') continue;
      calls.push({ name: t.name, arguments: JSON.stringify(t.input ?? {}) });
    }
  }
  return calls;
}

// cm:guard two on-disk shapes exist (desktop carries `entry.role`, the CLI runner carries `entry.type`) and `messageRoleToTurnRole` is the canonical normalizer for both — do not re-derive the discriminator here.
function finalAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messageRoleToTurnRole(messages[i]) !== 'assistant') continue;
    const content = (messages[i] as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) return content.trim();
  }
  return null;
}

/**
 * Stamp this session as the one that delivers, at most once.
 */
// cm:guard compare-and-set, so exactly one caller delivers even when the runner's happy-path PATCH and a kernel sweeper race on the same row.
// cm:guard the spread preserves sibling keys — the failover writes `failover` under the same marker, and rebuilding this object from the read shape alone would drop the attempt counter that bounds the retry.
async function claimDelivery(session: SessionRow, failure: string | null): Promise<boolean> {
  const prev = (session.metadata as Record<string, unknown>) ?? {};
  const prevMarker = (prev[CONVERSATION_AGENT_MARKER] as Record<string, unknown>) ?? {};
  const claimed = await db
    .update(agentSessions)
    .set({
      metadata: {
        ...prev,
        [CONVERSATION_AGENT_MARKER]: {
          ...prevMarker,
          deliveredAt: new Date().toISOString(),
          failure,
        },
      } as never,
    })
    .where(
      and(
        eq(agentSessions.id, session.id),
        // cm:guard the `::text` cast is load-bearing — drizzle renders the marker as a bind parameter, and `jsonb -> $1` with an untyped parameter is ambiguous in Postgres (`->` overloads on text and int), so it fails at runtime with "operator is not unique" rather than at build time.
        sql`(${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  return claimed.length > 0;
}

/** Re-stamp which failure the venue was shown, once the delivery is already claimed. */
async function stampFailure(sessionId: string, failure: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      metadata: sql`jsonb_set(${agentSessions.metadata}, ${sql.raw(`'{${CONVERSATION_AGENT_MARKER},failure}'`)}, ${JSON.stringify(failure)}::jsonb, true)`,
    })
    .where(eq(agentSessions.id, sessionId));
}

async function composeOutcome(session: SessionRow, meta: ConversationAgentMeta): Promise<Outcome> {
  const text = session.status === 'completed' ? finalAssistantText(session.messages) : null;
  if (!text) {
    return {
      text: meta.replies.failed,
      problems: [],
      failure:
        session.status === 'completed'
          ? 'the session finished without writing a reply'
          : `the session ended ${session.status}`,
    };
  }
  // cm:guard this door declares ZERO repairs and that is not an oversight: the text is the last message of a runner session that has already ended, so there is no turn to ask again and a budget here would be one the door could never spend. It still goes through `withRepairs` so the count lives in the door table beside its reason rather than as an absent loop nobody can see (ISS-997).
  const verdict = await withRepairs(meta.door, [text], {
    screen: () =>
      screenReplyAtDoor(meta.door, {
        projectId: session.projectId,
        segments: [text],
        toolCalls: extractToolCalls(session.messages),
        progress: readProgressFacts(session.metadata),
      }),
    rewrite: () => {
      throw new Error(`${meta.door} declares no repair; nothing can ask that session again`);
    },
  });
  if (verdict.kind === 'passed') return { text, problems: [], failure: null };
  logger.warn(
    {
      sessionId: session.id,
      conversationId: meta.conversationId,
      problems: problemsOf(verdict.verdict),
    },
    'conversation-agent-bridge: the session reply failed the screen; honest fallback',
  );
  return {
    text: meta.replies.failed,
    problems: [],
    failure: 'the reply this session wrote could not be shown here',
  };
}

/**
 * Deliver one runner-hosted conversation reply, at most once.
 */
// cm:guard best-effort throughout, and it MUST stay that way: both fire sites run after the terminal flip has committed, so a throw here would take a sweeper's whole pass down AFTER its rows went terminal.
export async function deliverConversationAgentReplyOnce(session: SessionRow): Promise<void> {
  const meta = readConversationAgentMeta(session.metadata);
  if (!meta) return;
  if (meta.deliveredAt) return;

  const transport = conversationTransport(meta.venue.adapter);
  if (!transport) {
    logger.error(
      { sessionId: session.id, adapter: meta.venue.adapter },
      'conversation-agent-bridge: no transport is registered for this venue; the answer is not delivered',
    );
    return;
  }

  // cm:guard the venue is checked BEFORE the claim and before any expensive work: a session runs long, and a room rebound or deleted while it ran is not this project's to answer into. Dropping this read would not post the answer — `deliver` refuses that itself — but it would spend a failover redispatch and a screening turn producing one first (ISS-1039, plan consult F1).
  if (transport.canDeliver && !(await transport.canDeliver(meta.venue))) {
    await claimDelivery(session, 'the room this was asked in is no longer reachable');
    logger.error(
      { sessionId: session.id, conversationId: meta.conversationId, adapter: meta.venue.adapter },
      'conversation-agent-bridge: the venue is no longer reachable; the answer is not posted',
    );
    return;
  }

  if (!(await claimDelivery(session, null))) return;

  // cm:why the claim above already stamped THIS session, so retrying here can never double-post — its "delivery" is really a hand-off to the retry. A content-side outcome is never retried, since retrying reproduces the same content decision; the deterministic non-infra failures are excluded because retrying them on every runner produces the same outcome.
  // cm:guard compare the RESOLVED cause, never the raw column — rows written before ISS-877 carry `ws-publish-failed` with a hyphen, and a literal comparison silently starts failing over the one class this list exists to exclude.
  const cause = resolveFailureCause(session.failureReason);
  if (
    session.status !== 'completed' &&
    cause !== 'user_cancelled' &&
    cause !== 'skill_not_synced' &&
    cause !== 'ws_publish_failed'
  ) {
    const failover = await redispatchConversationAgentTurn(session);
    if (failover.ok) return;
  }

  const outcome = await composeOutcome(session, meta);
  const message = outcome.failure
    ? codeAuthored(outcome.text)
    : (screened(outcome.text, { ok: true, problems: [...outcome.problems] }) ??
      codeAuthored(meta.replies.failed));

  try {
    const receipt = await transport.deliver(meta.venue, message);
    await recordDeliveredReply({
      conversationId: meta.conversationId,
      projectId: meta.venue.projectId,
      text: message.text,
      receipt,
      deliveryKey: meta.deliveryKey,
      decision: 'handed-off',
    });
  } catch (err) {
    // cm:guard nothing is recorded when the door refuses: the venue never saw this text, and a transcript row for it would say the opposite. The commonest refusal is a room rebound while the turn ran, which `deliver` names rather than swallows.
    logger.error(
      { err, sessionId: session.id, conversationId: meta.conversationId },
      'conversation-agent-bridge: the reply could not be delivered; nothing was recorded',
    );
    await stampFailure(session.id, 'the reply could not be delivered to this room');
    return;
  }

  if (outcome.failure) await stampFailure(session.id, outcome.failure);

  // cm:guard LAST, after both the transcript row and the failure stamp: this is what a tab refetches on, and a reader that refetched before either would read the room back without the answer and without the state that explains it.
  await transport
    .notifySettled?.(meta.venue)
    .catch((err: unknown) =>
      logger.warn(
        { err, sessionId: session.id, conversationId: meta.conversationId },
        'conversation-agent-bridge: delivered, but the settled event was not published',
      ),
    );
}
