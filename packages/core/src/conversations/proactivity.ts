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
// cm:guard the loop breaker has a TIME horizon and not only an identifier test, because the thing it is about is agents bouncing QUICKLY: an agent answering an hour later with nothing new in it is a slow exchange, and cutting that would make the guard a general ban on agents agreeing with each other (ISS-1004, review F4).
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
}

/**
 * Which of the messages in hand were written by an agent.
 */
// cm:guard agency is read off `users.kind` and NOT off "is this a handle of this room": an agent from ANOTHER project speaking here is exactly the cross-repo exchange the loop breaker must judge, and it holds no handle row in this conversation. An assistant row is this room's own handle and is an agent whatever its author column says.
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
// cm:guard every one of them measures from `anchor` — the newest message by somebody who is not an agent — so a person speaking lifts all three at once and writes nothing but their own message. Anchoring them anywhere else is how a room stays muted after the thing that muted it has gone (ISS-1004 rule 3).
export async function decideProactivity(
  input: ProactivityInput,
  tx: Executor = defaultDb,
): Promise<ProactivityVerdict> {
  const now = input.now ?? new Date();
  const messages = await readMessages(input.conversationId, GUARD_WINDOW, tx);
  const agents = await agentAuthors(messages, tx);

  // cm:guard a room with NO person message inside the guard window is treated as dormant from its oldest message rather than as fresh: a room whose only speakers are agents for longer than a day is the runaway this guard exists to stop, and reading "no anchor" as "no limit" inverts it.
  const persons = messages.filter((m) => !isAgentMessage(m, agents));
  const anchor = persons[persons.length - 1] ?? null;
  const anchorAt = anchor?.createdAt ?? messages[0]?.createdAt ?? now;

  const silentFor = now.getTime() - anchorAt.getTime();
  if (silentFor > DORMANT_MS) {
    return {
      speak: false,
      decision: 'guard-dormant',
      detail: { lastPersonAt: anchorAt.toISOString(), silentForMs: silentFor },
    };
  }

  const loop = agentLoop(messages, agents, anchor, now);
  if (loop) return loop;

  return backoff(input.conversationId, anchorAt, tx);
}

/**
 * Agent messages bouncing quickly with nothing new in them.
 */
// cm:guard the run is counted from the NEWEST message backwards and stops at the first person message or the first message that introduced something: a count over the whole history would cut a room that once had a quiet patch, for ever.
// cm:why the `seen` set is built from the messages BEFORE the run being judged, so a name the run itself keeps repeating is not new the second time it says it.
function agentLoop(
  messages: readonly StoredConversationMessage[],
  agents: ReadonlySet<string>,
  anchor: StoredConversationMessage | null,
  now: Date,
): ProactivityVerdict | null {
  const after = anchor
    ? messages.filter((m) => m.createdAt.getTime() > anchor.createdAt.getTime())
    : [...messages];
  if (after.length < LOOP_LIMIT) return null;

  const seen = new Set<string>();
  for (const m of messages) {
    if (after.includes(m)) break;
    for (const id of identifiersIn(m.content)) seen.add(id);
  }

  let run = 0;
  let previousAt = now.getTime();
  for (let i = after.length - 1; i >= 0; i--) {
    const m = after[i];
    if (!m) break;
    if (!isAgentMessage(m, agents)) break;
    // cm:guard the gap is measured against the message AFTER this one — the bounce is how fast the pair arrived, not how long ago the run started, so a burst an hour old is still a burst.
    if (previousAt - m.createdAt.getTime() > LOOP_BOUNCE_MS) break;
    if (introducesSomethingNew(m.content, seen)) break;
    previousAt = m.createdAt.getTime();
    run += 1;
    if (run >= LOOP_LIMIT) {
      return {
        speak: false,
        decision: 'guard-agent-loop',
        detail: { identicalRun: run, bounceMs: LOOP_BOUNCE_MS },
      };
    }
  }
  return null;
}

/**
 * Consecutive settled windows that found nothing to say.
 */
// cm:guard read from the WINDOW DECISIONS, which are already written for a person to read, and only those settled since the anchor: a decision taken before the last person spoke is about a room that no longer exists (ISS-1004 rule 3).
// cm:guard `undetermined` is skipped rather than counted: its outcome is not yet known, and counting it toward a back-off is a caller acting on it as a failure, which rule 4 forbids outright.
async function backoff(
  conversationId: string,
  since: Date,
  tx: Executor,
): Promise<ProactivityVerdict> {
  const decisions = await recentDecisions(conversationId, { since, limit: BACKOFF_AFTER + 4 }, tx);
  let run = 0;
  for (const d of decisions) {
    if (d.decision === 'undetermined') continue;
    if (d.decision !== 'nothing-to-say') break;
    run += 1;
  }
  if (run >= BACKOFF_AFTER) {
    return {
      speak: false,
      decision: 'guard-backoff',
      detail: { consecutiveQuietWindows: run, since: since.toISOString() },
    };
  }
  return { speak: true };
}
