// Typed record events (ISS-56): a `forge-record` is a row of `activity_log` with action
// `record.<kind>`, so a gate reads a table instead of parsing a thread.

import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { activityLog } from '../../db/schema-activity.js';
import { type ForgeRecord, overBudget, REQUESTED_FIELDS } from '../../messaging/forge-record.js';
import type { Actor } from '../../pipeline/activity.js';
import { recordEventVerdicts } from '../criteria/event-verdicts.js';
import {
  isRecordEventKind,
  RECORD_ACTION_PREFIX,
  type RECORD_DIGEST_KIND,
  RECORD_EVENT_KINDS,
  type RecordEventKind,
  recordAction,
} from './kinds.js';

/** The key shape a record field takes, the same one the comment fence reads (`forge-record.ts`). */
const FIELD_KEY = /^[a-z][a-z0-9-]*$/u;

/** How many fields one event may carry: a verdict names one block per criterion, so it is wide. */
export const RECORD_EVENT_MAX_FIELDS = 400;

export interface RecordEventField {
  readonly key: string;
  readonly value: string;
}

/** What a writer sends: the kind, the contract its fields are shaped by, and the fields in order. */
export interface RecordEventDraft {
  readonly kind: string;
  readonly contract: number;
  readonly fields: readonly RecordEventField[];
}

/** A stored event as every reader sees it. */
export interface RecordEvent {
  readonly id: string;
  readonly issueId: string;
  readonly kind: RecordEventKind | typeof RECORD_DIGEST_KIND;
  readonly contract: number;
  readonly fields: readonly RecordEventField[];
  readonly lead: string | null;
  readonly commentId: string | null;
  readonly counts?: Readonly<Record<string, number>>;
  readonly actorType: string;
  readonly actorId: string;
  readonly createdAt: Date;
}

export type RecordEventRefusalCode = 'EVENT_KIND_UNKNOWN' | 'EVENT_PAYLOAD_INVALID';

/** A draft that cannot be stored, refused by name: what was wrong, where, and the valid shape. */
export class RecordEventRefused extends Error {
  constructor(
    readonly code: RecordEventRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecordEventRefused';
  }
}

const KIND_LIST = RECORD_EVENT_KINDS.join(', ');

/**
 * The draft, checked, or the refusal naming its first fault. A digest is the collapse's own row and
 * no writer may author one, so it is refused alongside every kind outside the set.
 */
export function assertRecordEventDraft(draft: RecordEventDraft): void {
  if (!isRecordEventKind(draft.kind)) {
    throw new RecordEventRefused(
      'EVENT_KIND_UNKNOWN',
      `\`${String(draft.kind)}\` is not a record kind — a record event carries one of: ${KIND_LIST}`,
    );
  }
  if (!Number.isInteger(draft.contract) || draft.contract < 1) {
    throw new RecordEventRefused(
      'EVENT_PAYLOAD_INVALID',
      `contract \`${String(draft.contract)}\` is not a contract number — send the positive whole number the record's fields are shaped by, e.g. 1`,
    );
  }
  if (draft.fields.length === 0) {
    throw new RecordEventRefused(
      'EVENT_PAYLOAD_INVALID',
      `a \`${draft.kind}\` record carries no fields — send them as [{ key, value }] in the order written`,
    );
  }
  if (draft.fields.length > RECORD_EVENT_MAX_FIELDS) {
    throw new RecordEventRefused(
      'EVENT_PAYLOAD_INVALID',
      `a record carries at most ${RECORD_EVENT_MAX_FIELDS} fields and this one carries ${draft.fields.length}`,
    );
  }
  for (const [at, field] of draft.fields.entries()) {
    if (typeof field?.key !== 'string' || !FIELD_KEY.test(field.key)) {
      throw new RecordEventRefused(
        'EVENT_PAYLOAD_INVALID',
        `fields[${at}].key \`${String(field?.key)}\` is not a field name — a key is lower-case letters, digits and hyphens, starting with a letter`,
      );
    }
    if (typeof field.value !== 'string') {
      throw new RecordEventRefused(
        'EVENT_PAYLOAD_INVALID',
        `fields[${at}].value (\`${field.key}\`) is not text — every record field value is a string`,
      );
    }
  }
}

/** The fence reader's shape, rebuilt from stored fields, so every screen and reader takes either. */
export function recordOfFields(
  kind: string | null,
  contract: number | null,
  fields: readonly RecordEventField[],
): ForgeRecord {
  const held = new Set(fields.map((f) => f.key));
  return {
    kind,
    contract,
    fields: fields.map((f) => ({ key: f.key, value: f.value, over: overBudget(f.value) })),
    lead: fields.find((f) => f.key === 'lead')?.value ?? null,
    absent: REQUESTED_FIELDS.filter((key) => !held.has(key)),
    at: 0,
    to: 0,
  };
}

export function recordOfEvent(event: RecordEvent): ForgeRecord {
  return recordOfFields(event.kind, event.contract, event.fields);
}

interface StoredPayload {
  contract?: unknown;
  fields?: unknown;
  lead?: unknown;
  commentId?: unknown;
  counts?: unknown;
}

function fieldsOfPayload(raw: unknown): RecordEventField[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) =>
    f && typeof f === 'object' && typeof f.key === 'string' && typeof f.value === 'string'
      ? [{ key: f.key, value: f.value }]
      : [],
  );
}

type ActivityRow = typeof activityLog.$inferSelect;

function eventOfRow(row: ActivityRow): RecordEvent {
  const payload = (row.payload ?? {}) as StoredPayload;
  const kind = row.action.slice(RECORD_ACTION_PREFIX.length) as RecordEvent['kind'];
  return {
    id: row.id,
    issueId: row.issueId,
    kind,
    contract: typeof payload.contract === 'number' ? payload.contract : 1,
    fields: fieldsOfPayload(payload.fields),
    lead: typeof payload.lead === 'string' ? payload.lead : null,
    commentId: typeof payload.commentId === 'string' ? payload.commentId : null,
    ...(payload.counts && typeof payload.counts === 'object'
      ? { counts: payload.counts as Record<string, number> }
      : {}),
    actorType: row.actorType,
    actorId: row.actorId,
    createdAt: row.createdAt,
  };
}

/** The dedupe key a comment's mirrored event carries; `activity_log_record_comment_uq` keeps it one. */
export function commentMirrorKey(commentId: string): string {
  return `record-comment:${commentId}`;
}

export interface WriteRecordEventInput extends RecordEventDraft {
  readonly issueId: string;
  readonly actor: Actor;
  /** Set only by the comment mirror: the comment the record arrived in. */
  readonly commentId?: string | null;
  /** When the record was written, where that is earlier than this insert (the mirror's comment). */
  readonly at?: Date;
}

/** Store one checked event. The draft is checked here too, so no door can skip the refusal. */
export async function writeRecordEvent(
  input: WriteRecordEventInput,
  executor: Tx = db,
): Promise<RecordEvent> {
  assertRecordEventDraft(input);
  const kind = input.kind as RecordEventKind;
  const fields = input.fields.map((f) => ({ key: f.key, value: f.value }));
  const lead = fields.find((f) => f.key === 'lead')?.value ?? null;
  // One transaction: a verdict whose criterion rows are refused leaves no event behind (ISS-55).
  return executor.transaction(async (tx) => {
    const [row] = await tx
      .insert(activityLog)
      .values({
        issueId: input.issueId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorAgency: input.actor.agency,
        action: recordAction(kind),
        payload: {
          contract: input.contract,
          fields,
          lead,
          ...(input.commentId ? { commentId: input.commentId } : {}),
        },
        dedupeKey: input.commentId ? commentMirrorKey(input.commentId) : null,
        ...(input.at ? { createdAt: input.at } : {}),
      })
      .returning();
    if (!row) throw new Error('record event insert returned no row');
    if (kind === 'verdict') {
      await recordEventVerdicts(tx, {
        issueId: input.issueId,
        record: recordOfFields(kind, input.contract, fields),
        actor: input.actor,
        commentId: input.commentId ?? null,
      });
    }
    return eventOfRow(row);
  });
}

export interface RecordEventQuery {
  readonly kinds?: readonly (RecordEventKind | typeof RECORD_DIGEST_KIND)[];
  readonly limit?: number;
}

/** One issue's record events, oldest first, of the kinds asked for (every kind where none is). */
export async function listRecordEvents(
  issueId: string,
  query: RecordEventQuery = {},
  executor: Tx = db,
): Promise<RecordEvent[]> {
  const scope = query.kinds?.length
    ? inArray(activityLog.action, query.kinds.map(recordAction))
    : like(activityLog.action, `${RECORD_ACTION_PREFIX}%`);
  const base = executor
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.issueId, issueId), scope))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  const rows = query.limit ? await base.limit(query.limit) : await base;
  return rows.map(eventOfRow);
}

/** The ids of the comments whose record already stands as an event, so history never reads twice. */
export async function mirroredCommentIds(issueId: string, executor: Tx = db): Promise<Set<string>> {
  const rows = await executor
    .select({ key: activityLog.dedupeKey })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.issueId, issueId),
        like(activityLog.dedupeKey, `${commentMirrorKey('')}%`),
      ),
    );
  const prefix = commentMirrorKey('');
  return new Set(rows.flatMap((r) => (r.key ? [r.key.slice(prefix.length)] : [])));
}

/** The events these comments' records were mirrored into, keyed by comment id. */
export async function mirroredEventsFor(
  issueId: string,
  commentIds: readonly string[],
  executor: Tx = db,
): Promise<Map<string, RecordEvent>> {
  if (commentIds.length === 0) return new Map();
  const rows = await executor
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.issueId, issueId),
        inArray(activityLog.dedupeKey, commentIds.map(commentMirrorKey)),
      ),
    );
  const out = new Map<string, RecordEvent>();
  for (const row of rows) {
    const event = eventOfRow(row);
    if (event.commentId) out.set(event.commentId, event);
  }
  return out;
}
