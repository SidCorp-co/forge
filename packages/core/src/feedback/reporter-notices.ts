/**
 * The words a reporter reads in a notice about their item, built in one place so the preview a
 * triager sees and the notice that is sent are the same text, in the language each reporter reads
 * (`reporter-language.ts`). An internal note has no builder here: it is never a notice.
 */

import type { FeedbackShipEvidence } from '@forge/contracts/feedback';
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

/** A message a triager wrote, delivered as written under the item it is about. */
export function messageNotice(
  language: NoticeLanguage,
  key: string,
  title: string,
  text: string,
): NoticeText {
  return { title: noticeCopy(language, 'message.title', { key, title }), body: text.trim() };
}

/** What the record shows of the fix, as lines of the notice: the criterion's verdict, then its clip. */
function evidenceLines(language: NoticeLanguage, e: FeedbackShipEvidence | null): string[] {
  if (!e?.criterion) return [];
  const verdict =
    e.verdict === 'passing'
      ? noticeCopy(language, 'shipped.evidencePasses', { ref: e.criterion })
      : noticeCopy(language, 'shipped.evidenceReads', {
          ref: e.criterion,
          verdict: e.verdict ?? 'not_judged',
        });
  return e.clip
    ? [verdict, noticeCopy(language, 'shipped.clip', { name: e.clip.name })]
    : [verdict];
}

/**
 * That the item's work shipped, and the ask to confirm it (REQ-66 BC-8): in which release, what
 * changed for them in the release note's words, what the record shows of the fix, and what to do.
 */
export function shippedNotice(
  language: NoticeLanguage,
  key: string,
  title: string,
  version: string | null,
  said: readonly string[],
  evidence: FeedbackShipEvidence | null,
): NoticeText {
  const changed =
    said.length > 0
      ? said.join('\n')
      : version
        ? noticeCopy(language, 'shipped.body', { version })
        : noticeCopy(language, 'shipped.bodyNoRelease', {});
  return {
    title: version
      ? noticeCopy(language, 'shipped.title', { key, version, title })
      : noticeCopy(language, 'shipped.titleNoRelease', { key, title }),
    body: [
      changed,
      ...evidenceLines(language, evidence),
      noticeCopy(language, 'shipped.ask', {}),
    ].join('\n'),
  };
}

/**
 * A move somebody else made on the reporter's item (REQ-34 BC-21): triaged and where it went,
 * verified on their behalf, or reopened. Its decline and merge have notices of their own.
 */
export function stepNotice(
  language: NoticeLanguage,
  step: 'triaged' | 'verified' | 'reopened',
  key: string,
  title: string,
  carrier: string | null = null,
): NoticeText {
  const body =
    step === 'triaged'
      ? carrier
        ? noticeCopy(language, 'step.triaged.body', { carrier })
        : noticeCopy(language, 'step.triaged.bodyNoCarrier', {})
      : noticeCopy(language, `step.${step}.body`, {});
  return { title: noticeCopy(language, `step.${step}.title`, { key, title }), body };
}
