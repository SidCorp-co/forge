/**
 * The language a person reads Forge in: their own choice, else the project's content language, else
 * English. A reporter's bell notice is the kernel fact and words people wrote, so it is the same for
 * every reader (`reporter-notices.ts`); this answers the readers whose lines are still translated
 * (`status-reports/send.ts`).
 */

import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userPreferences } from '../db/schema.js';
import { languageOfTag } from '../lib/language-tag.js';
import { readContentLanguage } from '../project-config/index.js';

type ReaderLanguage = ReturnType<typeof languageOfTag>;

/** Each person's chosen language, else the project's content language, else English. */
export async function reporterLanguagesOf(
  userIds: readonly string[],
  projectId: string,
): Promise<Map<string, ReaderLanguage>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const prefs = await db
    .select({ userId: userPreferences.userId, language: userPreferences.language })
    .from(userPreferences)
    .where(inArray(userPreferences.userId, ids));
  const chosen = new Map(prefs.map((p) => [p.userId, p.language]));
  const fallback = ids.some((id) => !chosen.get(id))
    ? languageOfTag((await readContentLanguage(projectId)).contentLanguage)
    : 'en';
  return new Map(ids.map((id) => [id, chosen.get(id) ? languageOfTag(chosen.get(id)) : fallback]));
}
