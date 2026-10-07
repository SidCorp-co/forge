/**
 * The words a reporter reads in a notice about their item, built in one place so the preview a
 * triager sees and the notice that is sent are the same text. An internal note has no builder here:
 * it is never a notice.
 */

export interface NoticeText {
  title: string;
  body: string;
}

const about = (key: string, title: string) => `${key}: ${title}`;

/** A decline tells the reporter why, in the triager's own words. */
export function declinedNotice(key: string, title: string, reason: string): NoticeText {
  return {
    title: `${key} was declined: ${title}`,
    body: `It will not be done.\nReason: ${reason.trim()}`,
  };
}

/** A duplicate tells its reporter which item now carries their report. */
export function duplicateNotice(key: string, title: string, original: string): NoticeText {
  return {
    title: `${about(key, title)} is already reported as ${original}`,
    body: `Your report was merged into ${original}. You will hear about it there, and your report stays on record.`,
  };
}

/** The item was verified because nobody confirmed the fix inside the window. */
export function autoVerifiedNotice(key: string, title: string, days: number): NoticeText {
  return {
    title: `${key} was verified: ${title}`,
    body: `Verified automatically after ${days} days with no reply. If the fix does not answer your report, file it again as new feedback.`,
  };
}

/** A message a triager wrote, delivered as written under the item it is about. */
export function messageNotice(key: string, title: string, text: string): NoticeText {
  return { title: `A message about ${about(key, title)}`, body: text.trim() };
}
