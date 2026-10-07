/**
 * The words a reporter reads in a notice about their item, built in one place so the preview a
 * triager sees and the notice that is sent are the same text, in the language each reporter reads
 * (`reporter-language.ts`). An internal note has no builder here: it is never a notice.
 */

import { type NoticeLanguage, noticeCopy } from './reporter-language.js';

export interface NoticeText {
  title: string;
  body: string;
}

/** A decline tells the reporter why, in the triager's own words. */
export function declinedNotice(
  language: NoticeLanguage,
  key: string,
  title: string,
  reason: string,
): NoticeText {
  return {
    title: noticeCopy(language, 'declined.title', { key, title }),
    body: noticeCopy(language, 'declined.body', { reason: reason.trim() }),
  };
}

/** A duplicate tells its reporter which item now carries their report. */
export function duplicateNotice(
  language: NoticeLanguage,
  key: string,
  title: string,
  original: string,
): NoticeText {
  return {
    title: noticeCopy(language, 'duplicate.title', { key, title, original }),
    body: noticeCopy(language, 'duplicate.body', { original }),
  };
}

/** The item was verified because nobody confirmed the fix inside the window. */
export function autoVerifiedNotice(
  language: NoticeLanguage,
  key: string,
  title: string,
  days: number,
): NoticeText {
  return {
    title: noticeCopy(language, 'autoVerified.title', { key, title }),
    body: noticeCopy(language, 'autoVerified.body', { days: String(days) }),
  };
}

/** A message a triager wrote, delivered as written under the item it is about. */
export function messageNotice(
  language: NoticeLanguage,
  key: string,
  title: string,
  text: string,
): NoticeText {
  return { title: noticeCopy(language, 'message.title', { key, title }), body: text.trim() };
}

/** That the item's work shipped: in which release, and what changed for them in the release note's words. */
export function shippedNotice(
  language: NoticeLanguage,
  key: string,
  title: string,
  version: string | null,
  said: readonly string[],
): NoticeText {
  return {
    title: version
      ? noticeCopy(language, 'shipped.title', { key, version, title })
      : noticeCopy(language, 'shipped.titleNoRelease', { key, title }),
    body:
      said.length > 0
        ? said.join('\n')
        : version
          ? noticeCopy(language, 'shipped.body', { version })
          : noticeCopy(language, 'shipped.bodyNoRelease', {}),
  };
}
