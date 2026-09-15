/**
 * The one writer of a person's assistant preferences, and the trail every
 * write leaves (ISS-1034).
 *
 * Three actors write these — the person, an org admin, the assistant from a
 * room — and all three come through here, because the person's way back from
 * a change they did not make is the previous value, and only a writer that
 * records it can offer one.
 */

import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { type AnswerStyle, userPreferences } from '../db/schema.js';
import {
  type PreferenceChangeActor,
  type PreferenceChangeField,
  preferenceChanges,
} from '../db/schema-agent-selves.js';

export const ASSISTANT_PREFERENCE_DEFAULTS = {
  answerStyle: 'default' as AnswerStyle,
  assistantInstructions: null as string | null,
};

export interface AssistantPreferences {
  userId: string;
  answerStyle: AnswerStyle;
  assistantInstructions: string | null;
  updatedAt: Date | null;
}

export interface AssistantPreferencePatch {
  answerStyle?: AnswerStyle | undefined;
  assistantInstructions?: string | null | undefined;
}

export interface PreferenceActor {
  kind: PreferenceChangeActor;
  /** The person, the admin, or the handle that spoke. */
  userId: string | null;
}

export interface PreferenceChange {
  id: string;
  userId: string;
  field: PreferenceChangeField;
  previousValue: string | null;
  newValue: string | null;
  changedBy: PreferenceChangeActor;
  changedByUserId: string | null;
  conversationId: string | null;
  changedAt: Date;
}

type Tx = Pick<typeof defaultDb, 'select' | 'insert' | 'update'>;

// cm:guard every writer takes THIS lock before it reads the current value, and the restore takes it before its "still holds" check: two writes that both read the old value would each record it as their predecessor, and a restore racing a newer edit would pass its check and then erase that edit — the exact overwrite the trail exists to make visible. A transaction-scoped advisory lock keyed on the user works before a `user_preferences` row exists and is re-entrant for the restore's nested write (codex F2).
async function lockPreferences(
  tx: Pick<typeof defaultDb, 'execute'>,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('user_preferences'), hashtext(${userId}))`,
  );
}

const FIELD_OF: Record<keyof AssistantPreferencePatch, PreferenceChangeField> = {
  answerStyle: 'answer_style',
  assistantInstructions: 'assistant_instructions',
};

export async function readAssistantPreferences(
  userId: string,
  tx: Tx = defaultDb,
): Promise<AssistantPreferences> {
  const [row] = await tx
    .select({
      userId: userPreferences.userId,
      answerStyle: userPreferences.answerStyle,
      assistantInstructions: userPreferences.assistantInstructions,
      updatedAt: userPreferences.updatedAt,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return row ?? { userId, ...ASSISTANT_PREFERENCE_DEFAULTS, updatedAt: null };
}

/**
 * Write the fields the patch carries, and one `preference_changes` row per
 * field carried — a write is a write, whether or not the value moved.
 */
// cm:guard one row per field IN THE PATCH, not per field whose value changed: the trail answers "who last set this and to what" and a write that re-asserted the same value is still that actor's act; filtering it out would make an admin's confirmation of a setting invisible next to the assistant's earlier change (ISS-1034 criterion 58).
export async function writeAssistantPreferences(args: {
  userId: string;
  patch: AssistantPreferencePatch;
  actor: PreferenceActor;
  conversationId?: string | null | undefined;
  db?: typeof defaultDb;
}): Promise<AssistantPreferences> {
  const dbi = args.db ?? defaultDb;
  return dbi.transaction(async (tx) => {
    await lockPreferences(tx as unknown as typeof defaultDb, args.userId);
    const before = await readAssistantPreferences(args.userId, tx as unknown as Tx);
    const fields = (Object.keys(args.patch) as (keyof AssistantPreferencePatch)[]).filter(
      (k) => args.patch[k] !== undefined,
    );
    if (fields.length === 0) return before;

    const set = {
      ...(args.patch.answerStyle !== undefined ? { answerStyle: args.patch.answerStyle } : {}),
      ...(args.patch.assistantInstructions !== undefined
        ? { assistantInstructions: args.patch.assistantInstructions }
        : {}),
    };
    const [row] = await tx
      .insert(userPreferences)
      .values({ userId: args.userId, ...set })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...set, updatedAt: new Date() },
      })
      .returning({
        userId: userPreferences.userId,
        answerStyle: userPreferences.answerStyle,
        assistantInstructions: userPreferences.assistantInstructions,
        updatedAt: userPreferences.updatedAt,
      });
    if (!row) throw new Error('user_preferences: upsert returned no row');

    // cm:guard the row is stamped at the INSERT with `clock_timestamp()`, never with the transaction's `now()`: the lock above serialises writers that already opened their transactions, and `now()` is transaction start, so two racing writes would commit in one order and read back in the other — a trail whose `previousValue` chain and whose order disagree, and a restore that misses the later change it must name (ISS-1034 criteria 58, 61). What this does NOT buy is a total order: a same-microsecond tie or a clock stepped backwards can still misorder the list and misname the later change — and nothing more, because what refuses a restore is the field's CURRENT value below, never this stamp; a durable sequence under the lock is the fix if that cosmetic hole is ever seen.
    await tx.insert(preferenceChanges).values(
      fields.map((k) => ({
        userId: args.userId,
        changedAt: sql`clock_timestamp()`,
        field: FIELD_OF[k],
        previousValue: before[k] ?? null,
        newValue: (args.patch[k] as string | null | undefined) ?? null,
        changedBy: args.actor.kind,
        changedByUserId: args.actor.userId,
        conversationId: args.conversationId ?? null,
      })),
    );
    return row;
  });
}

export async function listPreferenceChanges(
  userId: string,
  tx: Tx = defaultDb,
): Promise<PreferenceChange[]> {
  return tx
    .select()
    .from(preferenceChanges)
    .where(eq(preferenceChanges.userId, userId))
    .orderBy(desc(preferenceChanges.changedAt))
    .limit(200);
}

export class PreferenceRestoreConflict extends Error {
  constructor(
    readonly change: PreferenceChange,
    readonly later: PreferenceChange | null,
  ) {
    super(
      later
        ? `${change.field} no longer holds the value change ${change.id} set; change ${later.id} (${later.changedBy}, ${later.changedAt.toISOString()}) set it since, so restoring would undo that one and not this`
        : `${change.field} no longer holds the value change ${change.id} set, so restoring would undo something this trail does not record`,
    );
    this.name = 'PreferenceRestoreConflict';
  }
}

/**
 * Put a field back to what it held before one change — only while the field
 * still holds what that change set. `null` when the change is not this
 * person's.
 */
// cm:guard the "still holds" check is the whole of what makes a restore safe: a person undoing the assistant's change from this morning must not silently erase the edit they made themselves at noon. The refusal names the later change so the person can restore THAT one instead (ISS-1034 criterion 61).
export async function restorePreferenceChange(args: {
  userId: string;
  changeId: string;
  actor: PreferenceActor;
  db?: typeof defaultDb;
}): Promise<AssistantPreferences | null> {
  const dbi = args.db ?? defaultDb;
  return dbi.transaction(async (tx) => {
    await lockPreferences(tx as unknown as typeof defaultDb, args.userId);
    const t = tx as unknown as Tx;
    const [change] = await t
      .select()
      .from(preferenceChanges)
      .where(
        and(eq(preferenceChanges.id, args.changeId), eq(preferenceChanges.userId, args.userId)),
      )
      .limit(1);
    if (!change) return null;

    const current = await readAssistantPreferences(args.userId, t);
    const key = change.field === 'answer_style' ? 'answerStyle' : 'assistantInstructions';
    if ((current[key] ?? null) !== (change.newValue ?? null)) {
      const [later] = await t
        .select()
        .from(preferenceChanges)
        .where(
          and(
            eq(preferenceChanges.userId, args.userId),
            eq(preferenceChanges.field, change.field),
            gt(preferenceChanges.changedAt, change.changedAt),
          ),
        )
        .orderBy(desc(preferenceChanges.changedAt))
        .limit(1);
      throw new PreferenceRestoreConflict(change, later ?? null);
    }

    const patch: AssistantPreferencePatch =
      change.field === 'answer_style'
        ? { answerStyle: (change.previousValue ?? 'default') as AnswerStyle }
        : { assistantInstructions: change.previousValue ?? null };
    return writeAssistantPreferences({
      userId: args.userId,
      patch,
      actor: args.actor,
      db: tx as unknown as typeof defaultDb,
    });
  });
}
