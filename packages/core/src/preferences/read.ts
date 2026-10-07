import type { ProductStateKey, ProductStateView } from '@forge/contracts/product-state';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type AnswerStyle, userPreferences } from '../db/schema.js';
import { userProductState } from '../db/schema-product-state.js';

export const ASSISTANT_PREFERENCE_DEFAULTS = {
  answerStyle: 'default' as AnswerStyle,
  assistantInstructions: null as string | null,
};

/** The columns `/preferences` answers. */
const FULL_PREFERENCES = {
  userId: userPreferences.userId,
  theme: userPreferences.theme,
  language: userPreferences.language,
  answerStyle: userPreferences.answerStyle,
  assistantInstructions: userPreferences.assistantInstructions,
  updatedAt: userPreferences.updatedAt,
};

/** The columns `/me/preferences` answers. */
export const ME_PREFERENCES = {
  theme: userPreferences.theme,
  language: userPreferences.language,
  notifyOnMention: userPreferences.notifyOnMention,
  activeOrgId: userPreferences.activeOrgId,
  updatedAt: userPreferences.updatedAt,
};

/** What a person who never saved a preference reads on `/me/preferences`. */
export const ME_PREFERENCE_DEFAULTS = {
  theme: 'system' as const,
  language: 'en' as const,
  notifyOnMention: true,
  activeOrgId: null as string | null,
};

/** A person's display and assistant preferences, the defaults where they saved none. */
export async function readPreferences(userId: string) {
  const [row] = await db
    .select(FULL_PREFERENCES)
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return (
    row ?? {
      userId,
      theme: 'system' as const,
      language: 'en' as const,
      answerStyle: ASSISTANT_PREFERENCE_DEFAULTS.answerStyle,
      assistantInstructions: ASSISTANT_PREFERENCE_DEFAULTS.assistantInstructions,
      updatedAt: null,
    }
  );
}

/** A person's `/me/preferences` row, the defaults where they saved none. */
export async function readMePreferences(userId: string) {
  const [row] = await db
    .select(ME_PREFERENCES)
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return row ?? { ...ME_PREFERENCE_DEFAULTS, updatedAt: null };
}

type StoredValue = NonNullable<ProductStateView['value']>;

export function productStateViewOf(row: {
  key: string;
  value: unknown;
  updatedAt: Date;
}): ProductStateView {
  return {
    key: row.key as ProductStateKey,
    value: row.value as StoredValue,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const PRODUCT_STATE_COLUMNS = {
  key: userProductState.key,
  value: userProductState.value,
  updatedAt: userProductState.updatedAt,
};

/** One key of a person's product state; `value` and `updatedAt` null where nothing was written. */
export async function readProductState(
  userId: string,
  key: ProductStateKey,
): Promise<ProductStateView> {
  const [row] = await db
    .select(PRODUCT_STATE_COLUMNS)
    .from(userProductState)
    .where(and(eq(userProductState.userId, userId), eq(userProductState.key, key)))
    .limit(1);
  return row ? productStateViewOf(row) : { key, value: null, updatedAt: null };
}

/** Every key a person has written. */
export async function listProductState(userId: string): Promise<ProductStateView[]> {
  const rows = await db
    .select(PRODUCT_STATE_COLUMNS)
    .from(userProductState)
    .where(eq(userProductState.userId, userId))
    .orderBy(asc(userProductState.key));
  return rows.map(productStateViewOf);
}
