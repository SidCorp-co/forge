// Withdrawing a decision (ISS-585, REQ-33 BC-2): a probe or a mistaken decision stops being read
// as one somebody stands behind, and nothing is deleted. The withdrawal is a kernel record core
// writes in the act's own transaction, naming the decision, who withdrew it, when and why; every
// read of standing records leaves the decision out from then on (`withdrawn.ts:notWithdrawnSql`).

import {
  type RecordEventKind,
  type RecordEventRefusalCode,
  recordAction,
  WITHDRAWABLE_RECORD_KINDS,
} from '@forge/contracts/record-events';
import { scrubSecretsDeep } from '@forge/observability';
import { db } from '../../db/client.js';
import { activityLog } from '../../db/schema-activity.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { refuser } from '../../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../../permissions/index.js';
import type { Actor } from '../activity.js';
import { type ActorType, actorKey } from '../actor-identity.js';
import { resolveActors } from '../actor-resolution.js';
import { type RecordEvent, recordEventOn } from './store.js';
import { WITHDRAWS_KEY, withdrawalsOn } from './withdrawn.js';

const refuse = refuser<RecordEventRefusalCode>('EVENT_REFUSED');

/** The one withdrawal a record may have: `activity_log_record_withdrawal_uq` keeps it one. */
const withdrawalKey = (eventId: string) => `record-withdrawal:${eventId}`;

/** The keys only core writes on a decision it records for an act, read on rows written before it marked them. */
const ACT_KEYS: Readonly<Record<string, string>> = {
  feedback: 'the feedback routing it records is changed on that feedback item',
  suggestion: 'the suggestion decision it records stands on that suggestion',
};

const isWithdrawable = (kind: string): boolean =>
  (WITHDRAWABLE_RECORD_KINDS as readonly string[]).includes(kind);

function coreActOf(event: RecordEvent): string | null {
  const key = event.fields.find((f) => ACT_KEYS[f.key] !== undefined)?.key;
  if (key) return ACT_KEYS[key] ?? null;
  return event.writer === 'core'
    ? 'core wrote it for an act, which is undone where it was made'
    : null;
}

const sameWriter = (event: RecordEvent, actor: Actor) =>
  event.actorType === actor.type && event.actorId === actor.id;

const when = (at: Date) => at.toISOString();

/** Refuse a record that is not this act's to withdraw, by name; return when it may be. */
async function assertWithdrawable(event: RecordEvent, issueKey: string): Promise<void> {
  if (!isWithdrawable(event.kind)) {
    throw refuse(
      'EVENT_WITHDRAW_KIND',
      `record ${event.id} on ${issueKey} is a \`${event.kind}\`, and only a ${WITHDRAWABLE_RECORD_KINDS.join(', ')} record is withdrawn — write a \`correction\` record saying what it got wrong`,
      '/eventId',
    );
  }
  const act = coreActOf(event);
  if (act) {
    throw refuse(
      'EVENT_WITHDRAW_CORE_ACT',
      `decision ${event.id} on ${issueKey} records an act core made, so it is not withdrawn here: ${act}`,
      '/eventId',
    );
  }
  if (event.commentId) {
    throw refuse(
      'EVENT_WITHDRAW_IN_COMMENT',
      `decision ${event.id} on ${issueKey} was written inside comment ${event.commentId}; take its fence out of that comment (\`PATCH /api/comments/${event.commentId}\`) or delete the comment, and the decision goes with it`,
      '/eventId',
    );
  }
  const earlier = (await withdrawalsOn(event.issueId)).get(event.id);
  if (earlier) throw await alreadyWithdrawn(event, issueKey, earlier.by, earlier.at);
}

async function alreadyWithdrawn(
  event: RecordEvent,
  issueKey: string,
  by: { type: string; id: string },
  at: Date,
) {
  const type = by.type as ActorType;
  const who = (await resolveActors([{ type, id: by.id }])).get(actorKey(type, by.id));
  return refuse(
    'EVENT_ALREADY_WITHDRAWN',
    `decision ${event.id} on ${issueKey} was withdrawn at ${when(at)} by ${who?.displayName ?? `${by.type} ${by.id}`}; a decision is withdrawn once`,
    '/eventId',
  );
}

export interface WithdrawInput {
  readonly projectId: string;
  readonly issueId: string;
  readonly issueKey: string;
  readonly eventId: string;
  readonly reason: string;
  /** Who withdraws it: the person, or the device a run writes from. */
  readonly actor: Actor;
  /** The person behind the request, whose role decides another writer's decision. */
  readonly userId: string;
}

/**
 * Withdraw one decision: its writer may, and anyone else holding `project.admin`, as changing
 * another person's comment needs. Returns the withdrawal record.
 */
export async function withdrawRecordEvent(input: WithdrawInput): Promise<RecordEvent> {
  const event = await recordEventOn(input.issueId, input.eventId);
  if (!event) {
    throw refuse(
      'EVENT_NOT_FOUND',
      `${input.issueKey} holds no record ${input.eventId}; \`GET /api/issues/:id/events\` lists the ones it holds`,
      '/eventId',
    );
  }
  await assertWithdrawable(event, input.issueKey);
  if (!sameWriter(event, input.actor)) {
    await requireCan(
      actorFor(input.userId),
      'project.admin',
      projectResource(input.projectId),
      'withdrawing a decision another writer recorded',
    );
  }
  const reason = scrubSecretsDeep(input.reason.trim());
  const fields = [
    { key: WITHDRAWS_KEY, value: event.id },
    { key: 'kind', value: event.kind as RecordEventKind },
    { key: 'reason', value: reason },
  ];
  try {
    const [row] = await db
      .insert(activityLog)
      .values({
        issueId: input.issueId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorAgency: input.actor.agency,
        action: recordAction('withdrawal'),
        payload: { contract: 1, fields, lead: reason, writer: 'core', [WITHDRAWS_KEY]: event.id },
        dedupeKey: withdrawalKey(event.id),
      })
      .returning();
    if (!row) throw new Error('withdrawal insert returned no row');
    const written = await recordEventOn(input.issueId, row.id);
    if (!written) throw new Error(`withdrawal ${row.id} vanished after its write`);
    return written;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = (await withdrawalsOn(event.issueId)).get(event.id);
    throw await alreadyWithdrawn(
      event,
      input.issueKey,
      raced?.by ?? input.actor,
      raced?.at ?? new Date(),
    );
  }
}
