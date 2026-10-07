import type { OnboardingStatus } from '@forge/contracts/onboarding';
import { requirementKey } from '@forge/contracts/requirements';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  CONVERSATION_AGENT_MARKER,
  readConversationAgentMeta,
  turnState,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { conversationMessages, conversationWindows } from '../db/schema-conversations.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { requirements } from '../db/schema-requirements.js';
import { firstRequirementsOnboardingOf, onboardingStatusesOf } from '../onboarding/index.js';

export interface ThreadMark {
  kind: 'onboarding' | 'requirement' | 'first_requirements' | null;
  /** The thread's badge, as `threadStatusOf` reads it. */
  threadStatus: OnboardingStatus;
  /** The record the room is about, by key (`REQ-3` for a requirement's BA room); null for a project room. */
  subjectKey: string | null;
}

export interface ThreadFacts {
  onboarding: OnboardingStatus | null;
  /** A questionnaire batch in this room is still open. */
  batchOpen: boolean;
  /** A message in this room waits for its reply: a window not yet settled, or a runner turn still out. */
  replyPending: boolean;
  /** The room's newest said message is the agent's, and it closes on a question (`closesOnQuestion`). */
  agentAsked: boolean;
}

// an onboarding thread wears its onboarding's own status; any other room waits on the person
// while a batch is open, is in progress while a reply is still being made, waits on the person
// again when the agent's last word asked them something, and is done otherwise — the prototype's
// conversation status, so every row of the list carries one (REQ-11 BC-8, ISS-277)
export function threadStatusOf(f: ThreadFacts): OnboardingStatus {
  if (f.onboarding) return f.onboarding;
  if (f.batchOpen) return 'waiting_on_you';
  if (f.replyPending) return 'in_progress';
  if (f.agentAsked) return 'waiting_on_you';
  return 'done';
}

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;
// a sentence ending on a question mark (ASCII or full-width), past any closing emphasis, quote or
// bracket: `?` inside a link's query is followed by more of the link and is no question
const ASKS = /[?\uFF1F][*_)"'\u201D\u2019\u00BB\]]*(?:\s|$)/;

/**
 * Whether an agent's message ends its turn asking the reader something: a question in its closing
 * paragraph, or in the paragraph a closing list of options hangs from. A question earlier in the
 * message is one it went on to answer.
 */
export function closesOnQuestion(text: string): boolean {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const last = paragraphs.at(-1);
  if (!last) return false;
  if (ASKS.test(last)) return true;
  const isList = last.split('\n').every((line) => LIST_LINE.test(line));
  const before = paragraphs.at(-2);
  return isList && before !== undefined && ASKS.test(before);
}

/** The rooms among these whose newest said message (no system line, no silence) is the agent's, asking. */
async function roomsWhereAgentAsked(conversationIds: readonly string[]): Promise<Set<string>> {
  const asked = new Set<string>();
  if (conversationIds.length === 0) return asked;
  const newest = await db
    .selectDistinctOn([conversationMessages.conversationId], {
      conversationId: conversationMessages.conversationId,
      role: conversationMessages.role,
      content: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(
      and(
        inArray(conversationMessages.conversationId, [...conversationIds]),
        ne(conversationMessages.role, 'system'),
        isNull(conversationMessages.silenceReason),
      ),
    )
    .orderBy(conversationMessages.conversationId, desc(conversationMessages.seq));
  for (const m of newest) {
    if (m.role === 'assistant' && closesOnQuestion(m.content)) asked.add(m.conversationId);
  }
  return asked;
}

/** The rooms among these holding a runner-hosted turn that is still dispatched or running. */
async function roomsWithLiveAgentTurn(conversationIds: readonly string[]): Promise<Set<string>> {
  const live = new Set<string>();
  if (conversationIds.length === 0) return live;
  const rows = await db
    .select({
      status: agentSessions.status,
      runtimeState: agentSessions.runtimeState,
      metadata: agentSessions.metadata,
    })
    .from(agentSessions)
    .where(
      sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'conversationId' IN (${sql.join(
        conversationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  for (const row of rows) {
    const meta = readConversationAgentMeta(row.metadata);
    if (!meta) continue;
    const state = turnState(row, meta);
    if (state === 'dispatched' || state === 'running') live.add(meta.conversationId);
  }
  return live;
}

/** What the conversation list and detail show beside each room: its kind, status and subject. */
export async function threadMarks(
  rooms: readonly { id: string; requirementId: string | null; externalId: string | null }[],
): Promise<Map<string, ThreadMark>> {
  const ids = rooms.map((r) => r.id);
  const out = new Map<string, ThreadMark>();
  if (ids.length === 0) return out;
  const requirementIds = [
    ...new Set(rooms.flatMap((r) => (r.requirementId ? [r.requirementId] : []))),
  ];
  const [onboarded, waiting, unsettled, turns, subjects, asked] = await Promise.all([
    onboardingStatusesOf(ids),
    db
      .select({ conversationId: questionnaireBatches.conversationId })
      .from(questionnaireBatches)
      .where(
        and(
          inArray(questionnaireBatches.conversationId, ids),
          eq(questionnaireBatches.status, 'open'),
        ),
      ),
    db
      .selectDistinct({ conversationId: conversationWindows.conversationId })
      .from(conversationWindows)
      .where(
        and(inArray(conversationWindows.conversationId, ids), isNull(conversationWindows.closedAt)),
      ),
    roomsWithLiveAgentTurn(ids),
    requirementIds.length
      ? db
          .select({ id: requirements.id, reqSeq: requirements.reqSeq })
          .from(requirements)
          .where(inArray(requirements.id, requirementIds))
      : Promise.resolve([]),
    roomsWhereAgentAsked(ids),
  ]);
  const status = onboarded;
  const open = new Set(waiting.map((w) => w.conversationId));
  const pending = new Set(unsettled.map((w) => w.conversationId));
  const keyOf = new Map(subjects.map((s) => [s.id, requirementKey(s.reqSeq)]));
  for (const r of rooms) {
    const onboarding = status.get(r.id) ?? null;
    out.set(r.id, {
      kind: onboarding
        ? 'onboarding'
        : r.requirementId
          ? 'requirement'
          : firstRequirementsOnboardingOf(r.externalId)
            ? 'first_requirements'
            : null,
      threadStatus: threadStatusOf({
        onboarding,
        batchOpen: open.has(r.id),
        replyPending: pending.has(r.id) || turns.has(r.id),
        agentAsked: asked.has(r.id),
      }),
      subjectKey: r.requirementId ? (keyOf.get(r.requirementId) ?? null) : null,
    });
  }
  return out;
}
