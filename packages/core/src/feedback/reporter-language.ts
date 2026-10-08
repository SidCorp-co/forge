/**
 * The language a notice to a reporter is written in, as the web reads its chrome
 * (`web-v2/src/lib/i18n/interface-language.tsx:resolveInterfaceLanguage`): the person's own choice,
 * else the project's content language, else English. Content a person wrote (a release note's
 * user-facing line, the item's title, a triager's reason) stays as written; only the words around it
 * are translated.
 */

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { userPreferences } from '../db/schema.js';
import { languageOfTag } from '../lib/language-tag.js';
import { emitEvent } from '../outbox/index.js';
import { readContentLanguage } from '../project-config/index.js';
import copy from './reporter-copy.json' with { type: 'json' };

export type NoticeLanguage = keyof typeof copy;
type NoticeCopyKey = keyof (typeof copy)['en'];

/** Each person's chosen language, else the project's content language, else English. */
export async function reporterLanguagesOf(
  userIds: readonly string[],
  projectId: string,
): Promise<Map<string, NoticeLanguage>> {
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

export async function reporterLanguageOf(
  userId: string,
  projectId: string,
): Promise<NoticeLanguage> {
  return (await reporterLanguagesOf([userId], projectId)).get(userId) ?? 'en';
}

/** One line of a reporter's notice in `language`, its `{name}` slots filled. */
export function noticeCopy(
  language: NoticeLanguage,
  key: NoticeCopyKey,
  vars: Record<string, string>,
): string {
  return copy[language][key].replace(/\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}

type Told = OutboxEventPayload<'feedback.reporterTold'>;

/**
 * Tells reporters one notice each in the language they read: one `feedback.reporterTold` per
 * language among `recipients`, its text built for that language.
 */
export async function tellReporters(
  tx: Tx,
  told: Omit<Told, 'recipients' | 'title' | 'body'>,
  recipients: readonly string[],
  build: (language: NoticeLanguage) => { title: string; body: string },
): Promise<void> {
  if (recipients.length === 0) return;
  const languages = await reporterLanguagesOf(recipients, told.projectId);
  const groups = new Map<NoticeLanguage, string[]>();
  for (const id of recipients) {
    const lang = languages.get(id) ?? 'en';
    groups.set(lang, [...(groups.get(lang) ?? []), id]);
  }
  for (const [language, ids] of groups) {
    await emitEvent(tx, 'feedback.reporterTold', { ...told, recipients: ids, ...build(language) });
  }
}
