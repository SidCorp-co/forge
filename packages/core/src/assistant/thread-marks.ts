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
  /** The room's newest said message is an agent reply recorded as awaiting the viewer's answer. */
  agentAsked: boolean;
}

// an onboarding thread wears its onboarding's own status; any other room waits on the viewer
// while a batch they may answer is open, is in progress while a reply is still being made, waits on
// the viewer when the agent's last reply was recorded as awaiting their answer, and is done
// otherwise, for a reader the agent's question was not put to as well — the prototype's
// conversation status, so every row of the list carries one (REQ-11 BC-8, ISS-277)
export function threadStatusOf(f: ThreadFacts): OnboardingStatus {
  if (f.onboarding) return f.onboarding;
  if (f.batchOpen) return 'waiting_on_you';
  if (f.replyPending) return 'in_progress';
  if (f.agentAsked) return 'waiting_on_you';
  return 'done';
}

/**
 * The rooms among these in which the viewer owes the agent an answer: the room's newest said
 * message (no system line, no silence) is an agent reply recorded as awaiting an answer
 * (`awaits_reply`, written when its turn called `await_reply`), recorded as waiting on the viewer
 * (`awaits_reply_from`, the person its turn answered). Neither the reply's text nor who wrote
 * before it is read: no rule over prose can tell a question that waits from one the agent answered
 * or echoed, and the newest person to write before the reply may have written while the turn was
 * out (ISS-277, probe P7). A reply that awaits an answer and names nobody waits on nobody.
 */
async function roomsWhereAgentAsked(
  conversationIds: readonly string[],
  viewerId: string,
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const newest = await db
    .selectDistinctOn([conversationMessages.conversationId], {
      conversationId: conversationMessages.conversationId,
      role: conversationMessages.role,
      awaitsReply: conversationMessages.awaitsReply,
      awaitsReplyFrom: conversationMessages.awaitsReplyFrom,
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
  return new Set(
    newest
      .filter((m) => m.role === 'assistant' && m.awaitsReply && m.awaitsReplyFrom === viewerId)
      .map((m) => m.conversationId),
  );
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
