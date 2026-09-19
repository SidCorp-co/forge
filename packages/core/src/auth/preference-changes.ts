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

/**
 * The one form `assistantInstructions` is compared and stored in: outer
 * whitespace trimmed, blank text null, internal whitespace kept.
 */
export function canonicalInstructions(v: string | null): string | null {
  const t = v?.trim() ?? '';
  return t.length ? t : null;
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
    const patch: AssistantPreferencePatch = {
      ...(args.patch.answerStyle !== undefined ? { answerStyle: args.patch.answerStyle } : {}),
      ...(args.patch.assistantInstructions !== undefined
        ? { assistantInstructions: canonicalInstructions(args.patch.assistantInstructions) }
        : {}),
    };
    const stored: Record<keyof AssistantPreferencePatch, string | null> = {
      answerStyle: before.answerStyle,
      assistantInstructions: canonicalInstructions(before.assistantInstructions),
    };
    const fields = (Object.keys(patch) as (keyof AssistantPreferencePatch)[]).filter(
      (k) => patch[k] !== undefined && (patch[k] ?? null) !== stored[k],
    );
    if (fields.length === 0) return before;
    const set = {
      ...(fields.includes('answerStyle') ? { answerStyle: patch.answerStyle } : {}),
      ...(fields.includes('assistantInstructions')
        ? { assistantInstructions: patch.assistantInstructions }
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

    await tx.insert(preferenceChanges).values(
      fields.map((k) => ({
        userId: args.userId,
        changedAt: sql`clock_timestamp()`,
        field: FIELD_OF[k],
        previousValue: stored[k],
        newValue: (patch[k] as string | null | undefined) ?? null,
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
    const same =
      key === 'assistantInstructions'
        ? canonicalInstructions(current[key]) === canonicalInstructions(change.newValue)
        : (current[key] ?? null) === (change.newValue ?? null);
    if (!same) {
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
