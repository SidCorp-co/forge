// Typed record events (ISS-56): a `forge-record` is a row of `activity_log` with action
// `record.<kind>`, so a gate reads a table instead of parsing a thread.

import {
  isKernelOnlyRecordKind,
  isRecordEventKind,
  KERNEL_ONLY_RECORD_KINDS,
  type KernelOnlyRecordKind,
  RECORD_ACTION_PREFIX,
  type RECORD_DIGEST_KIND,
  RECORD_EVENT_KINDS,
  RECORD_KIND_FIELDS,
  type RecordEventKind,
  type RecordEventRefusalCode,
  recordAction,
} from '@forge/contracts/record-events';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { activityLog } from '../../db/schema-activity.js';
import { refuser } from '../../lib/refusal.js';
import { type ForgeRecord, overBudget, REQUESTED_FIELDS } from '../../messaging/forge-record.js';
import type { Actor } from '../activity.js';
import { notWithdrawnSql, type RecordWithdrawn, withdrawalsOn } from './withdrawn.js';

/** The key shape a record field takes, the same one the comment fence reads (`forge-record.ts`). */
const FIELD_KEY = /^[a-z][a-z0-9-]*$/u;

/** How many fields one event may carry: a verdict names one block per criterion, so it is wide. */
const RECORD_EVENT_MAX_FIELDS = 400;

export interface RecordEventField {
  readonly key: string;
  readonly value: string;
}

/** What a writer sends: the kind, the contract its fields are shaped by, and the fields in order. */
interface RecordEventDraft {
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
  readonly writer: 'core' | 'client';
  readonly actorType: string;
  readonly actorId: string;
  readonly createdAt: Date;
  /** Who took this record back, when and why: present only on a read that asks for withdrawn ones. */
  readonly withdrawn?: RecordWithdrawn;
}

const refuse = refuser<RecordEventRefusalCode>('EVENT_REFUSED');

const KIND_LIST = RECORD_EVENT_KINDS.join(', ');

const KERNEL_ACTS: Record<KernelOnlyRecordKind, string> = {
  transition: 'a transition when the issue moves (`POST /api/issues/:id/transition`)',
  park: "a park when the issue moves to `needs_info` or `on_hold`, carrying the move's `reason`",
  verdict: 'a verdict when one is recorded on a criterion (`POST /api/issues/:id/verdicts`)',
  withdrawal:
    'a withdrawal when a decision is withdrawn (`POST /api/issues/:id/events/:eventId/withdraw`)',
};

/**
 * The draft, checked, or the refusal naming its first fault. A digest is the collapse's own row and
 * no writer may author one, so it is refused alongside every kind outside the set.
 */
export function assertRecordEventDraft(draft: RecordEventDraft): void {
  assertRecordEventShape(draft);
  if (isKernelOnlyRecordKind(draft.kind)) {
    throw refuse(
      'EVENT_KIND_KERNEL_ONLY',
      `\`${draft.kind}\` is kernel evidence core writes in the transaction of the act it records (${KERNEL_ONLY_RECORD_KINDS.join(', ')}), and no caller may post one: core writes ${KERNEL_ACTS[draft.kind]}. Make the act; the record follows it.`,
      '/kind',
    );
  }
  assertKindFields(draft);
}

/**
 * A kind whose fields are a closed set (`RECORD_KIND_FIELDS`) carries no other key: the first
 * stranger is refused at its pointer, naming every key the kind takes (ISS-585).
 */
function assertKindFields(draft: RecordEventDraft): void {
  const accepted = RECORD_KIND_FIELDS[draft.kind as RecordEventKind];
  if (!accepted) return;
  const at = draft.fields.findIndex((field) => !accepted.includes(field.key));
  if (at < 0) return;
  const key = draft.fields[at]?.key;
  throw refuse(
    'EVENT_FIELD_UNKNOWN',
    `fields[${at}].key \`${String(key)}\` is not a field of a \`${draft.kind}\` record — a ${draft.kind} carries ${accepted.map((k) => `\`${k}\``).join(', ')}. Say the rest in one of them, or in a comment`,
    `/fields/${at}/key`,
  );
}

function assertRecordEventShape(draft: RecordEventDraft): void {
  if (!isRecordEventKind(draft.kind)) {
    throw refuse(
      'EVENT_KIND_UNKNOWN',
      `\`${String(draft.kind)}\` is not a record kind — a record event carries one of: ${KIND_LIST}`,
      '/kind',
    );
  }
  if (!Number.isInteger(draft.contract) || draft.contract < 1) {
    throw refuse(
      'EVENT_PAYLOAD_INVALID',
      `contract \`${String(draft.contract)}\` is not a contract number — send the positive whole number the record's fields are shaped by, e.g. 1`,
      '/contract',
    );
  }
  if (draft.fields.length === 0) {
    throw refuse(
      'EVENT_PAYLOAD_INVALID',
      `a \`${draft.kind}\` record carries no fields — send them as [{ key, value }] in the order written`,
      '/fields',
    );
  }
  if (draft.fields.length > RECORD_EVENT_MAX_FIELDS) {
    throw refuse(
      'EVENT_PAYLOAD_INVALID',
      `a record carries at most ${RECORD_EVENT_MAX_FIELDS} fields and this one carries ${draft.fields.length}`,
      '/fields',
    );
  }
  for (const [at, field] of draft.fields.entries()) {
    if (typeof field?.key !== 'string' || !FIELD_KEY.test(field.key)) {
      throw refuse(
        'EVENT_PAYLOAD_INVALID',
        `fields[${at}].key \`${String(field?.key)}\` is not a field name — a key is lower-case letters, digits and hyphens, starting with a letter`,
        `/fields/${at}/key`,
      );
    }
    if (typeof field.value !== 'string') {
      throw refuse(
        'EVENT_PAYLOAD_INVALID',
        `fields[${at}].value (\`${field.key}\`) is not text — every record field value is a string`,
        `/fields/${at}/value`,
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
  writer?: unknown;
}

const KERNEL_WRITER = 'core';

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
    writer: payload.writer === KERNEL_WRITER ? 'core' : 'client',
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
  const [row] = await executor
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
  return eventOfRow(row);
}

interface KernelRecordInput {
  readonly issueId: string;
  readonly actor: Actor;
  readonly kind: KernelOnlyRecordKind;
  readonly fields: readonly RecordEventField[];
  readonly commentId?: string | null;
}

// runs on the executor of the act it records, so the act and its record commit or roll back
// together; no caller's draft reaches it
export async function writeKernelRecord(executor: Tx, input: KernelRecordInput): Promise<void> {
  const fields = input.fields.map((f) => ({ key: f.key, value: f.value }));
  assertRecordEventShape({ kind: input.kind, contract: 1, fields });
  await executor.insert(activityLog).values({
    issueId: input.issueId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorAgency: input.actor.agency,
    action: recordAction(input.kind),
    payload: {
      contract: 1,
      fields,
      lead: null,
      writer: KERNEL_WRITER,
      ...(input.commentId ? { commentId: input.commentId } : {}),
    },
  });
}

/** The kinds core writes on its own account although a caller may post one too. */
type CoreWrittenKind = Extract<RecordEventKind, 'verification' | 'review' | 'decision'>;

/**
 * A record core writes from a check it decided itself (the merge check's `verification`, a review's
 * `review`) or for an act it made (a feedback routing's or a suggestion's `decision`, ISS-585),
 * marked as core's so a reader asking `kernelOnly` never takes a caller's post of the same kind for
 * it, and so no caller withdraws it: the act is undone where it was made.
 */
export async function writeCoreRecord(
  executor: Tx,
  input: {
    issueId: string;
    actor: Actor;
    kind: CoreWrittenKind;
    fields: readonly RecordEventField[];
  },
): Promise<RecordEvent> {
  const fields = input.fields.map((f) => ({ key: f.key, value: f.value }));
  assertRecordEventShape({ kind: input.kind, contract: 1, fields });
  const lead = fields.find((f) => f.key === 'lead')?.value ?? null;
  const [row] = await executor
    .insert(activityLog)
    .values({
      issueId: input.issueId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      actorAgency: input.actor.agency,
      action: recordAction(input.kind),
      payload: { contract: 1, fields, lead, writer: KERNEL_WRITER },
    })
    .returning();
  if (!row) throw new Error('record event insert returned no row');
  return eventOfRow(row);
}

interface RecordEventQuery {
  readonly kinds?: readonly (RecordEventKind | typeof RECORD_DIGEST_KIND)[];
  readonly limit?: number;
  readonly kernelOnly?: boolean;
  /**
   * A withdrawn record is no longer read as standing, so it is left out unless this is `include`,
   * which keeps it and says on it who withdrew it, when and why. The withdrawal itself is a record
   * of its own and is always listed (ISS-585).
   */
  readonly withdrawn?: 'exclude' | 'include';
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
  const written = query.kernelOnly
    ? sql`${activityLog.payload}->>'writer' = ${KERNEL_WRITER}`
    : undefined;
  const include = query.withdrawn === 'include';
  const standing = include ? undefined : notWithdrawnSql;
  const base = executor
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.issueId, issueId), scope, written, standing))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  const rows = query.limit ? await base.limit(query.limit) : await base;
  const events = rows.map(eventOfRow);
  if (!include) return events;
  const withdrawals = await withdrawalsOn(issueId, executor);
  return events.map((event) => {
    const withdrawn = withdrawals.get(event.id);
    return withdrawn ? { ...event, withdrawn } : event;
  });
}

/** One record on this issue by its id, withdrawn or not, or null where the issue holds none. */
export async function recordEventOn(
  issueId: string,
  eventId: string,
  executor: Tx = db,
): Promise<RecordEvent | null> {
  const [row] = await executor
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.issueId, issueId),
        eq(activityLog.id, eventId),
        like(activityLog.action, `${RECORD_ACTION_PREFIX}%`),
      ),
    );
  return row ? eventOfRow(row) : null;
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
