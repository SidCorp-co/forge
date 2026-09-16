/**
 * Whether an agent should speak into a room nobody summoned it to.
 *
 * Three guards, catching three different things: a room where consecutive
 * windows route to nobody backs off, agent messages bouncing quickly with
 * nothing new in them are cut, and a room no person has spoken in for a day
 * stops being spoken to.
 *
 * Every one of them is DERIVED, at the moment it is asked, from the message log
 * and the window decisions. None of them is stored, and none of them is reset:
 * all three are anchored at the newest message by a person, so "a person spoke,
 * so proactivity resumes" is a consequence of that message existing rather than
 * a write somebody has to remember to make. A stored counter makes it a write
 * that can be missed, and a missed one leaves a room muted with no readable
 * cause (ISS-1004 rule 3).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { users } from '../db/schema.js';
import type { ConversationWindowDecision } from '../db/schema-conversations.js';
import type { Executor } from './db-executor.js';
import { identifiersIn, introducesSomethingNew } from './identifiers.js';
import { readMessages, type StoredConversationMessage } from './store.js';
import { recentDecisions } from './windows.js';

/** A room nobody has spoken in for this long stops being spoken to. */
export const DORMANT_MS = 24 * 60 * 60 * 1000;

/** How many consecutive settled windows may find nothing to say before the room is paced. */
export const BACKOFF_AFTER = 3;

/**
 * How close two agent messages have to be for the second to count as a bounce.
 */
export const LOOP_BOUNCE_MS = 5 * 60 * 1000;

/** How many identifier-free agent messages in a row are a loop rather than a pause. */
export const LOOP_LIMIT = 3;

/** How far back the guards read. Bounded, because every turn pays for this query. */
export const GUARD_WINDOW = 60;

export type ProactivityGuard = Extract<
  ConversationWindowDecision,
  'guard-backoff' | 'guard-agent-loop' | 'guard-dormant'
>;

export type ProactivityVerdict =
  | { speak: true }
  | { speak: false; decision: ProactivityGuard; detail: Record<string, unknown> };

export interface ProactivityInput {
  conversationId: string;
  now?: Date;
  /** The room's numbers; absent, today's constants (ISS-1034). */
  thresholds?: ProactivityThresholds | undefined;
}

/** The four numbers the guards read. Semantics never move; only these do. */
export interface ProactivityThresholds {
  dormantMs: number;
  backoffAfter: number;
  loopBounceMs: number;
  loopLimit: number;
}

export const DEFAULT_THRESHOLDS: ProactivityThresholds = {
  dormantMs: DORMANT_MS,
  backoffAfter: BACKOFF_AFTER,
  loopBounceMs: LOOP_BOUNCE_MS,
  loopLimit: LOOP_LIMIT,
};

/**
 * Which of the messages in hand were written by an agent.
 */
async function agentAuthors(
  messages: readonly StoredConversationMessage[],
  tx: Executor,
): Promise<Set<string>> {
  const ids = [...new Set(messages.flatMap((m) => (m.authorUserId ? [m.authorUserId] : [])))];
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.kind, 'agent')));
  return new Set(rows.map((r) => r.id));
}

function isAgentMessage(m: StoredConversationMessage, agents: ReadonlySet<string>): boolean {
  if (m.role === 'assistant') return true;
  return m.authorUserId !== null && agents.has(m.authorUserId);
}

/**
 * The three guards, asked together.
 */
export async function decideProactivity(
  input: ProactivityInput,
  tx: Executor = defaultDb,
): Promise<ProactivityVerdict> {
  const now = input.now ?? new Date();
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const messages = await readMessages(input.conversationId, GUARD_WINDOW, tx);
  const agents = await agentAuthors(messages, tx);

  const persons = messages.filter((m) => !isAgentMessage(m, agents));
  const anchor = persons[persons.length - 1] ?? null;
  const anchorAt = anchor?.createdAt ?? messages[0]?.createdAt ?? now;

  const silentFor = now.getTime() - anchorAt.getTime();
  if (silentFor > t.dormantMs) {
    return {
      speak: false,
      decision: 'guard-dormant',
      detail: { lastPersonAt: anchorAt.toISOString(), silentForMs: silentFor },
    };
  }

  const loop = agentLoop(messages, agents, anchor, t);
  if (loop) return loop;

  return backoff(input.conversationId, anchorAt, t, tx);
}

/**
 * Agent messages bouncing quickly with nothing new in them.
 */
function agentLoop(
  messages: readonly StoredConversationMessage[],
  agents: ReadonlySet<string>,
  anchor: StoredConversationMessage | null,
  t: ProactivityThresholds,
): ProactivityVerdict | null {
  const after = anchor
    ? messages.filter((m) => m.createdAt.getTime() > anchor.createdAt.getTime())
    : [...messages];
  if (after.length < t.loopLimit) return null;

  const seen = new Set<string>();
  const carriedNothing: boolean[] = [];
  for (const m of messages) {
    const fresh = introducesSomethingNew(m.content, seen);
    for (const id of identifiersIn(m.content)) seen.add(id);
    if (after.includes(m)) carriedNothing.push(!fresh);
  }

  let run = 0;
  let previousAt: number | null = null;
  for (let i = after.length - 1; i >= 0; i--) {
    const m = after[i];
    if (!m) break;
    if (!isAgentMessage(m, agents)) break;
    if (previousAt !== null && previousAt - m.createdAt.getTime() > t.loopBounceMs) break;
    if (!carriedNothing[i]) break;
    previousAt = m.createdAt.getTime();
    run += 1;
    if (run >= t.loopLimit) {
      return {
        speak: false,
        decision: 'guard-agent-loop',
        detail: { identicalRun: run, bounceMs: t.loopBounceMs },
      };
    }
  }
  return null;
}

/**
 * Consecutive settled windows that found nothing to say.
 */
async function backoff(
  conversationId: string,
  since: Date,
  t: ProactivityThresholds,
  tx: Executor,
): Promise<ProactivityVerdict> {
  const decisions = await recentDecisions(conversationId, { since, limit: t.backoffAfter + 4 }, tx);
  let run = 0;
  for (const d of decisions) {
    if (d.decision === 'undetermined') continue;
    if (d.decision === 'guard-backoff') {
      run += 1;
      continue;
    }
    if (d.decision !== 'nothing-to-say') break;
    run += 1;
  }
  if (run >= t.backoffAfter) {
    return {
      speak: false,
      decision: 'guard-backoff',
      detail: { consecutiveQuietWindows: run, since: since.toISOString() },
    };
  }
  return { speak: true };
}
