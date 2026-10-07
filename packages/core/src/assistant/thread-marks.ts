import type { OnboardingStatus } from '@forge/contracts/onboarding';
import { requirementKey } from '@forge/contracts/requirements';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  CONVERSATION_AGENT_MARKER,
  readConversationAgentMeta,
  turnState,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import { agentSessions, users } from '../db/schema.js';
import {
  conversationMessages,
  conversationParticipants,
  conversationWindows,
} from '../db/schema-conversations.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { requirements } from '../db/schema-requirements.js';
import { firstRequirementsOnboardingOf, onboardingStatusesOf } from '../onboarding/index.js';
import { actorFor, can, projectResource } from '../permissions/index.js';

export interface ThreadMark {
  kind: 'onboarding' | 'requirement' | 'first_requirements' | null;
  /** The thread's badge, as `threadStatusOf` reads it. */
  threadStatus: OnboardingStatus;
  /** The record the room is about, by key (`REQ-3` for a requirement's BA room); null for a project room. */
  subjectKey: string | null;
}

export interface ThreadFacts {
  onboarding: OnboardingStatus | null;
  /** A questionnaire batch in this room is still open, and the viewer may answer it. */
  batchOpen: boolean;
  /** A message in this room waits for its reply: a window not yet settled, or a runner turn still out. */
  replyPending: boolean;
  /** The room's newest said message is the agent's, closing on a question (`closesOnQuestion`) put to the viewer. */
  agentAsked: boolean;
}

// an onboarding thread wears its onboarding's own status; any other room waits on the viewer
// while a batch they may answer is open, is in progress while a reply is still being made, waits on the viewer
// when the agent's last word asked them something, and is done otherwise, for a reader the
// agent's question was not put to as well — the prototype's conversation status, so every row of
// the list carries one (REQ-11 BC-8, ISS-277)
export function threadStatusOf(f: ThreadFacts): OnboardingStatus {
  if (f.onboarding) return f.onboarding;
  if (f.batchOpen) return 'waiting_on_you';
  if (f.replyPending) return 'in_progress';
  if (f.agentAsked) return 'waiting_on_you';
  return 'done';
}

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;
const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/;
const QUOTE_LINE = /^\s{0,3}>/;
const CODE_LINE = /^(?: {4}|\t)/;
// a span the agent quotes or writes as code says nothing about what the agent asks: each becomes
// one opaque word before the end is read (straight single quotes stay, being apostrophes too)
const CODE_SPAN = /`+[^`\n]*`+/g;
const QUOTED_SPAN =
  /"[^"\n]*"|\u201C[^\u201D\n]*\u201D|\u2018[^\u2019\n]*\u2019|\u00AB[^\u00BB\n]*\u00BB|\u300C[^\u300D\n]*\u300D|\u300E[^\u300F\n]*\u300F/g;
// the question marks a sentence may end on: ASCII, full-width, small, Arabic, Greek (U+037E),
// Ethiopic, the interrobang and the doubled forms; then only closing emphasis or a bracket, so a
// question a quote closes (`"Can we ship?"`, `'…?'`) is the quote's, not the agent's
const ENDS_ASKING = /[?\uFF1F\uFE56\u061F\u037E\u1367\u203D\u2047\u2048\u2049][*_)]*$/;
// Greek writes its question mark as the ASCII semicolon too, so `;` asks only after Greek script
const ENDS_ASKING_IN_GREEK = /[\u0370-\u03FF\u1F00-\u1FFF][^.!?;\n]*;[*_)]*$/;

function endsAsking(line: string): boolean {
  const prose = line.replace(CODE_SPAN, 'code').replace(QUOTED_SPAN, 'quote').trimEnd();
  return ENDS_ASKING.test(prose) || ENDS_ASKING_IN_GREEK.test(prose);
}

const isBlank = (line: string): boolean => line.trim() === '';

/** Whether a line is prose the agent wrote in its own voice: not a quote, a fence or a list item. */
function isProse(line: string): boolean {
  return !QUOTE_LINE.test(line) && !FENCE_LINE.test(line) && !LIST_LINE.test(line);
}

/**
 * Whether an agent's message ends its turn asking the reader something: its last sentence is a
 * question, or the sentence a closing list of options hangs from is. Only the end counts, in the
 * agent's own prose: a question it went on to answer, one it quotes, and a `?` in code (a ternary,
 * a SQL placeholder) or in a link are none. What it declines — a request phrased as a statement,
 * a question followed by a code block, table, quote or sign-off — is a miss, read as not asking.
 */
export function closesOnQuestion(text: string): boolean {
  const lines = text.trimEnd().split('\n');
  // a message that ends inside or on a code block ends on code, not on a question
  if (lines.filter((l) => FENCE_LINE.test(l)).length % 2 === 1) return false;
  const fromEnd = [...lines].reverse();
  const last = fromEnd[0];
  if (last === undefined || isBlank(last)) return false;
  // the closing paragraph indented as a whole is a code block
  const closingLength = fromEnd.findIndex(isBlank);
  const closing = closingLength === -1 ? fromEnd : fromEnd.slice(0, closingLength);
  if (closing.every((l) => CODE_LINE.test(l))) return false;
  // the last line is the agent's own unless it quotes; a list item that asks is the end asking
  if (!QUOTE_LINE.test(last) && endsAsking(last)) return true;
  if (!LIST_LINE.test(last)) return false;
  // a closing list of options: the question is the prose line it hangs from
  const lead = fromEnd.find((l) => !LIST_LINE.test(l) && !isBlank(l));
  return lead !== undefined && isProse(lead) && !CODE_LINE.test(lead) && endsAsking(lead);
}

/**
 * The rooms among these in which the viewer owes the agent an answer: the room's newest said
 * message (no system line, no silence) is the agent's, asking, and it was put to the viewer. A
 * question is put to the person whose message the agent answered, the newest a person (not another
 * agent) said; where no person has spoken yet, to every person in the room.
 */
async function roomsWhereAgentAsked(
  conversationIds: readonly string[],
  viewerId: string,
): Promise<Set<string>> {
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
  const asking = newest
    .filter((m) => m.role === 'assistant' && closesOnQuestion(m.content))
    .map((m) => m.conversationId);
  if (asking.length === 0) return asked;
  const [answered, members] = await Promise.all([
    db
      .selectDistinctOn([conversationMessages.conversationId], {
        conversationId: conversationMessages.conversationId,
        authorUserId: conversationMessages.authorUserId,
      })
      .from(conversationMessages)
      .leftJoin(users, eq(users.id, conversationMessages.authorUserId))
      .where(
        and(
          inArray(conversationMessages.conversationId, asking),
          eq(conversationMessages.role, 'user'),
          isNull(conversationMessages.silenceReason),
          or(isNull(users.kind), ne(users.kind, 'agent')),
        ),
      )
      .orderBy(conversationMessages.conversationId, desc(conversationMessages.seq)),
    db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(
        and(
          inArray(conversationParticipants.conversationId, asking),
          eq(conversationParticipants.kind, 'person'),
          eq(conversationParticipants.userId, viewerId),
          isNull(conversationParticipants.removedAt),
        ),
      ),
  ]);
  const putTo = new Map(answered.map((m) => [m.conversationId, m.authorUserId]));
  const inRoom = new Set(members.map((m) => m.conversationId));
  for (const id of asking) {
    if (putTo.has(id) ? putTo.get(id) === viewerId : inRoom.has(id)) asked.add(id);
  }
  return asked;
}

/**
 * The rooms among these holding an open questionnaire batch the viewer may answer: a batch is
 * answered by any holder of `questionnaires.answer` on its project, and waits on no one else.
 */
async function roomsWithBatchForViewer(
  conversationIds: readonly string[],
  viewerId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({
      conversationId: questionnaireBatches.conversationId,
      projectId: questionnaireBatches.projectId,
    })
    .from(questionnaireBatches)
    .where(
      and(
        inArray(questionnaireBatches.conversationId, [...conversationIds]),
        eq(questionnaireBatches.status, 'open'),
      ),
    );
  const answerable = new Map<string, boolean>();
  for (const pid of new Set(rows.map((r) => r.projectId))) {
    answerable.set(
      pid,
      await can(actorFor(viewerId), 'questionnaires.answer', projectResource(pid)),
    );
  }
  return new Set(rows.filter((r) => answerable.get(r.projectId)).map((r) => r.conversationId));
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

/** What the conversation list and detail show the viewer beside each room: its kind, status and subject. */
export async function threadMarks(
  rooms: readonly { id: string; requirementId: string | null; externalId: string | null }[],
  viewerId: string,
): Promise<Map<string, ThreadMark>> {
  const ids = rooms.map((r) => r.id);
  const out = new Map<string, ThreadMark>();
  if (ids.length === 0) return out;
  const requirementIds = [
    ...new Set(rooms.flatMap((r) => (r.requirementId ? [r.requirementId] : []))),
  ];
  const [onboarded, waiting, unsettled, turns, subjects, asked] = await Promise.all([
    onboardingStatusesOf(ids),
    roomsWithBatchForViewer(ids, viewerId),
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
    roomsWhereAgentAsked(ids, viewerId),
  ]);
  const status = onboarded;
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
        batchOpen: waiting.has(r.id),
        replyPending: pending.has(r.id) || turns.has(r.id),
        agentAsked: asked.has(r.id),
      }),
      subjectKey: r.requirementId ? (keyOf.get(r.requirementId) ?? null) : null,
    });
  }
  return out;
}
