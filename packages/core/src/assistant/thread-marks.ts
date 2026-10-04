import type { OnboardingStatus } from '@forge/contracts/onboarding';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  CONVERSATION_AGENT_MARKER,
  readConversationAgentMeta,
  turnState,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { conversationWindows } from '../db/schema-conversations.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { requirements } from '../db/schema-requirements.js';
import { onboardingStatusesOf } from '../onboarding/index.js';

export interface ThreadMark {
  kind: 'onboarding' | 'requirement' | null;
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
}

// cm:why an onboarding thread wears its onboarding's own status; any other room waits on the person
// while a batch is open, is in progress while a reply is still being made, and is done otherwise —
// the prototype's conversation status, so every row of the list carries one (REQ-11 BC-8)
function threadStatusOf(f: ThreadFacts): OnboardingStatus {
  if (f.onboarding) return f.onboarding;
  if (f.batchOpen) return 'waiting_on_you';
  if (f.replyPending) return 'in_progress';
  return 'done';
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
  rooms: readonly { id: string; requirementId: string | null }[],
): Promise<Map<string, ThreadMark>> {
  const ids = rooms.map((r) => r.id);
  const out = new Map<string, ThreadMark>();
  if (ids.length === 0) return out;
  const requirementIds = [
    ...new Set(rooms.flatMap((r) => (r.requirementId ? [r.requirementId] : []))),
  ];
  const [onboarded, waiting, unsettled, turns, subjects] = await Promise.all([
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
  ]);
  const status = onboarded;
  const open = new Set(waiting.map((w) => w.conversationId));
  const pending = new Set(unsettled.map((w) => w.conversationId));
  const keyOf = new Map(subjects.map((s) => [s.id, requirementKey(s.reqSeq)]));
  for (const r of rooms) {
    const onboarding = status.get(r.id) ?? null;
    out.set(r.id, {
      kind: onboarding ? 'onboarding' : r.requirementId ? 'requirement' : null,
      threadStatus: threadStatusOf({
        onboarding,
        batchOpen: open.has(r.id),
        replyPending: pending.has(r.id) || turns.has(r.id),
      }),
      subjectKey: r.requirementId ? (keyOf.get(r.requirementId) ?? null) : null,
    });
  }
  return out;
}
