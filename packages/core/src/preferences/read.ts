import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type AnswerStyle, userPreferences } from '../db/schema.js';

export const ASSISTANT_PREFERENCE_DEFAULTS = {
  answerStyle: 'default' as AnswerStyle,
  assistantInstructions: null as string | null,
};

/** The columns `/preferences` answers. */
export const FULL_PREFERENCES = {
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
  lastSeenWhatsNew: userPreferences.lastSeenWhatsNew,
  activeOrgId: userPreferences.activeOrgId,
  updatedAt: userPreferences.updatedAt,
};

/** What a person who never saved a preference reads on `/me/preferences`. */
export const ME_PREFERENCE_DEFAULTS = {
  theme: 'system' as const,
  language: 'en' as const,
  notifyOnMention: true,
  lastSeenWhatsNew: null as string | null,
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
