/**
 * The language a notice to a reporter is written in, as the web reads its chrome
 * (`web-v2/src/lib/i18n/interface-language.tsx:resolveInterfaceLanguage`): the person's own choice,
 * else the project's content language, else English. Content a person wrote (a release note's
 * user-facing line, the item's title) stays as written; only the words around it are translated.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userPreferences } from '../db/schema.js';
import { readContentLanguage } from '../project-config/index.js';
import copy from './reporter-copy.json' with { type: 'json' };

export type NoticeLanguage = keyof typeof copy;
type NoticeCopyKey = keyof (typeof copy)['en'];

const baseOf = (tag: string | null | undefined): NoticeLanguage =>
  tag?.toLowerCase().split('-')[0] === 'vi' ? 'vi' : 'en';

/** The person's chosen language, else the project's content language, else English. */
export async function reporterLanguageOf(
  userId: string,
  projectId: string,
): Promise<NoticeLanguage> {
  const [pref] = await db
    .select({ language: userPreferences.language })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  if (pref?.language) return baseOf(pref.language);
  return baseOf((await readContentLanguage(projectId)).contentLanguage);
}

/** One line of a reporter's notice in `language`, its `{name}` slots filled. */
export function noticeCopy(
  language: NoticeLanguage,
  key: NoticeCopyKey,
  vars: Record<string, string>,
): string {
  return copy[language][key].replace(/\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}
