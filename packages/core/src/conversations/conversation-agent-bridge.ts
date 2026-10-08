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

import type { FailureCause } from '@forge/contracts/failure-causes';
import { resolveFailureCause } from '@forge/contracts/failure-causes';
import {
  claimSessionMarker,
  messageRoleToTurnRole,
  provideTerminalSessionBridge,
  readTranscript,
  setSessionMarkerField,
  stampSessionMarker,
} from '../agent-sessions/index.js';
import type { agentSessions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { droppedAs, type StagedBlock } from '../lib/staged-block.js';
import { refusalsOf } from '../messaging/contract.js';
import type { ProgressFacts } from '../messaging/facts.js';
import { withRepairs } from '../messaging/repairs.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { redispatchConversationAgentTurn } from './conversation-agent-failover.js';
import {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  type HeldReply,
  heldBecause,
  readConversationAgentMeta,
} from './conversation-agent-meta.js';
import { agentTurnOfSession } from './conversation-agent-stage.js';
import { codeAuthored, conversationTransport, type ScreenedMessage, screened } from './ports.js';
import { recordDeliveredReply } from './transcript.js';

type SessionRow = typeof agentSessions.$inferSelect;

/**
 * What the venue is told: the screened reply with the blocks it releases, a notice that the screen
 * held the reply the session wrote (its blocks held with it), or — only where the session left no
 * reply at all — the door's failure sentence.
 */
type Outcome =
  | { kind: 'answered'; message: ScreenedMessage; blocks: readonly StagedBlock[] }
  | { kind: 'held'; message: ScreenedMessage; held: HeldReply }
  | { kind: 'failed'; message: ScreenedMessage; failure: string };

function readProgressFacts(metadata: unknown): ProgressFacts | null {
  const pf = (metadata as Record<string, unknown> | null)?.progressFacts;
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

/**
 * What each of the session's tool calls returned, as text: an Agent session's report runs are named
 * there. A result is settled onto its call (`toolCalls[].output`), or stands as its own `tool_result`
 * entry where no assistant entry held the call.
 */
function toolResultTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const asText = (v: unknown): string | null =>
    v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v);
  const out: string[] = [];
  for (const entry of messages) {
    const e = entry as { type?: unknown; toolOutput?: unknown; toolCalls?: unknown } | null;
    if (!e) continue;
    const own = e.type === 'tool_result' ? asText(e.toolOutput) : null;
    if (own !== null) out.push(own);
    if (!Array.isArray(e.toolCalls)) continue;
    for (const tc of e.toolCalls) {
      const output = asText((tc as { output?: unknown } | null)?.output);
      if (output !== null) out.push(output);
    }
  }
  return out;
}

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
async function claimDelivery(session: SessionRow, failure: string | null): Promise<boolean> {
  const at = new Date().toISOString();
  return claimSessionMarker(session, CONVERSATION_AGENT_MARKER, {
    claimedAt: at,
    ...(failure ? { deliveredAt: at, failure } : { failure: null }),
  });
}

/** The answer is in the transcript: stamp the fact, which is what the screen reads. */
async function stampDelivered(sessionId: string): Promise<void> {
  await stampSessionMarker(sessionId, CONVERSATION_AGENT_MARKER, {
    deliveredAt: new Date().toISOString(),
  });
}

/** Re-stamp which failure the venue was shown, once the delivery is already claimed. */
async function stampFailure(sessionId: string, failure: string): Promise<void> {
  await setSessionMarkerField(sessionId, CONVERSATION_AGENT_MARKER, 'failure', failure);
}

/** Where a held reply can be read, by the venue it was asked in. */
const HELD_REPLY_IS = {
  'web-agent-completion':
    'Use "Show the held reply" on this turn to read it as the session wrote it.',
  'agent-chat-completion': 'The reply is kept on the Agent session in Forge.',
} as const;

/** The notice a venue is shown in place of a reply the screen held. Never the "no answer" sentence: there was one. */
function heldNotice(meta: ConversationAgentMeta, held: HeldReply): string {
  return `The agent wrote a reply, but the reply check held it back. ${heldBecause(held.refusals)} ${HELD_REPLY_IS[meta.door]}`;
}

async function composeOutcome(
  session: SessionRow,
  meta: ConversationAgentMeta,
  staged: readonly StagedBlock[],
): Promise<Outcome> {
  const messages = session.status === 'completed' ? await readTranscript(session.id) : [];
  const text = session.status === 'completed' ? finalAssistantText(messages) : null;
  if (!text) {
    return {
      kind: 'failed',
      message: codeAuthored(meta.replies.failed),
      failure:
        session.status === 'completed'
          ? 'the session finished without writing a reply'
          : `the session ended ${session.status}`,
    };
  }
  const verdict = await withRepairs(meta.door, [text], {
    screen: () =>
      screenReplyAtDoor(meta.door, {
        projectId: session.projectId,
        segments: [text],
        toolCalls: extractToolCalls(messages),
        progress: readProgressFacts(session.metadata),
        question: meta.question,
        restResults: toolResultTexts(messages),
        heldBlocks: staged.map((b) => b.block.visual),
      }),
    rewrite: () => {
      throw new Error(`${meta.door} declares no repair; nothing can ask that session again`);
    },
  });
  if (verdict.kind === 'passed') {
    const message = screened(text, meta.door, verdict.verdict);
    if (!message) {
      throw new Error(
        `conversation-agent-bridge: session ${session.id} passed the ${meta.door} screen over a text its proof does not cover`,
      );
    }
    return { kind: 'answered', message, blocks: staged };
  }
  const held: HeldReply = {
    at: new Date().toISOString(),
    text,
    refusals: refusalsOf(verdict.verdict).map((r) => ({
      rule: r.rule,
      why: r.why,
      quote: r.quote,
      shape: r.shape,
    })),
    blocks: [...staged],
  };
  logger.warn(
    {
      sessionId: session.id,
      conversationId: meta.conversationId,
      rules: held.refusals.map((r) => r.rule),
      heldBlocks: staged.length,
    },
    'conversation-agent-bridge: the screen held the session reply; the room is told why',
  );
  return { kind: 'held', message: codeAuthored(heldNotice(meta, held)), held };
}

/** The blocks waiting on this session's reply, read once its delivery is claimed and nothing more can join them. */
async function stagedOf(sessionId: string): Promise<StagedBlock[]> {
  const read = await agentTurnOfSession(sessionId);
  return read.found ? (read.turn?.staged ?? []) : [];
}

/** Name in the turn's record the blocks nobody will see, and why. */
async function stampDropped(
  session: SessionRow,
  meta: ConversationAgentMeta,
  staged: readonly StagedBlock[],
  why: string,
): Promise<void> {
  if (staged.length === 0) return;
  logger.warn(
    { sessionId: session.id, conversationId: meta.conversationId, blocks: staged.length, why },
    'conversation-agent-bridge: the blocks this turn drew are dropped',
  );
  await setSessionMarkerField(session.id, CONVERSATION_AGENT_MARKER, 'droppedBlocks', [
    ...meta.droppedBlocks,
    ...droppedAs(staged, why),
  ]);
}

/**
 * Deliver one runner-hosted conversation reply, at most once.
 */
/**
 * The causes another box cannot cure: a person stopped it, the skill never synced, or a file it
 * carries cannot be read. A missing checkout, a credential that would not mint or a hand-over that
 * threw are about one box, so they fail over (ISS-219).
 */
const NO_FAILOVER: ReadonlySet<FailureCause> = new Set<FailureCause>([
  'user_cancelled',
  'skill_not_synced',
  'attachment_unreadable',
]);

async function deliverConversationAgentReplyOnce(session: SessionRow): Promise<void> {
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

  if (transport.canDeliver && !(await transport.canDeliver(meta.venue))) {
    await claimDelivery(session, 'the room this was asked in is no longer reachable');
    logger.error(
      { sessionId: session.id, conversationId: meta.conversationId, adapter: meta.venue.adapter },
      'conversation-agent-bridge: the venue is no longer reachable; the answer is not posted',
    );
    return;
  }

  if (!(await claimDelivery(session, null))) return;
  const staged = await stagedOf(session.id);

  if (
    session.status !== 'completed' &&
    !NO_FAILOVER.has(resolveFailureCause(session.failureReason))
  ) {
    const failover = await redispatchConversationAgentTurn(session);
    if (failover.ok) {
      await stampDropped(
        session,
        meta,
        staged,
        'the turn moved to another box, whose session draws its own blocks',
      );
      await stampDelivered(session.id);
      return;
    }
  }

  const outcome = await composeOutcome(session, meta, staged);
  const { message } = outcome;
  if (outcome.kind === 'held') {
    await setSessionMarkerField(session.id, CONVERSATION_AGENT_MARKER, 'held', outcome.held);
  }
  if (outcome.kind === 'failed') {
    await stampDropped(session, meta, staged, `no reply went out: ${outcome.failure}`);
  }

  try {
    const receipt = await transport.deliver(
      meta.venue,
      message,
      outcome.kind === 'answered' ? { blocks: outcome.blocks } : undefined,
    );
    await recordDeliveredReply({
      conversationId: meta.conversationId,
      projectId: meta.venue.projectId,
      text: message.text,
      receipt,
      deliveryKey: meta.deliveryKey,
      decision: 'handed-off',
    });
    await stampDelivered(session.id);
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, conversationId: meta.conversationId },
      'conversation-agent-bridge: the reply could not be delivered; nothing was recorded',
    );
    await stampFailure(session.id, 'the reply could not be delivered to this room');
    return;
  }

  if (outcome.kind === 'failed') await stampFailure(session.id, outcome.failure);

  await transport
    .notifySettled?.(meta.venue)
    .catch((err: unknown) =>
      logger.warn(
        { err, sessionId: session.id, conversationId: meta.conversationId },
        'conversation-agent-bridge: delivered, but the settled event was not published',
      ),
    );
}

/** Hands the kernel this module's delivery for a session that answers a conversation. */
export function registerConversationAgentBridge(): void {
  provideTerminalSessionBridge('conversationAgent', deliverConversationAgentReplyOnce);
}
