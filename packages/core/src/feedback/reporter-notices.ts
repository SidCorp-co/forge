/**
 * What a reporter's bell holds about their item: the kernel fact — the item's key, the step it took,
 * the release where there is one, and its title as the reporter wrote it — and, as the body, only
 * words a person or an agent wrote (a triager's reason or message, a release note's user-facing line).
 * No agent speaks on the bell, so core composes no sentence here (owner ruling agent-is-the-voice,
 * ISS-857): no ask to confirm or reopen — verify and reopen stay the item's own actions. The preview a
 * triager sees and the notice that is sent are built here, so they are the same text.
 */

import type { FeedbackShipEvidence } from '@forge/contracts/feedback';
import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import type { Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';

export interface NoticeText {
  title: string;
  body: string;
}

/** The fact line: its parts joined by a dot, an empty part left out. */
const fact = (...parts: (string | null | undefined)[]): string =>
  parts.filter((p): p is string => Boolean(p?.trim())).join(' · ');

/** A decline carries the triager's reason as written. */
export function declinedNotice(key: string, title: string, reason: string): NoticeText {
  return { title: fact(key, 'declined', title), body: reason.trim() };
}

/** A duplicate names the item that now carries the report. */
export function duplicateNotice(key: string, title: string, original: string): NoticeText {
  return { title: fact(key, `duplicate of ${original}`, title), body: '' };
}

/** A message a triager wrote, delivered as written under the item it is about. */
export function messageNotice(key: string, title: string, text: string): NoticeText {
  return { title: fact(key, 'message', title), body: text.trim() };
}

/** What the record shows of the fix: the criterion and whether it passes, then its clip's name. */
function evidenceFacts(e: FeedbackShipEvidence | null): string[] {
  if (!e?.criterion) return [];
  const verdict = fact(e.criterion, e.verdict === 'passing' ? 'passing' : 'not passing');
  return e.clip ? [verdict, fact('clip', e.clip.name)] : [verdict];
}

/**
 * That the item's work shipped (REQ-66 BC-8): the release in the title, and as the body what the
 * release notes say changed for users, then what the record shows of the fix.
 */
export function shippedNotice(
  key: string,
  title: string,
  version: string | null,
  said: readonly string[],
  evidence: FeedbackShipEvidence | null,
): NoticeText {
  return {
    title: fact(key, 'shipped', version, title),
    body: [...said, ...evidenceFacts(evidence)].join('\n'),
  };
}

/** That a resolved item waits on its reporter's verify or reopen, which are the item's actions. */
export function verifyAskNotice(key: string, title: string): NoticeText {
  return { title: fact(key, 'resolved', title), body: '' };
}

/**
 * A move somebody else made on the reporter's item (REQ-34 BC-21): triaged and where it went,
 * verified on their behalf, or reopened. Its decline and merge have notices of their own.
 */
export function stepNotice(
  step: 'triaged' | 'verified' | 'reopened',
  key: string,
  title: string,
  carrier: string | null = null,
): NoticeText {
  const moved = step === 'triaged' && carrier ? `triaged to ${carrier}` : step;
  return { title: fact(key, moved, title), body: '' };
}

type Told = OutboxEventPayload<'feedback.reporterTold'>;

/** Tells `recipients` one notice: one `feedback.reporterTold` event, the text the preview showed. */
export async function tellReporters(
  tx: Tx,
  told: Omit<Told, 'recipients' | 'title' | 'body'>,
  recipients: readonly string[],
  notice: NoticeText,
): Promise<void> {
  if (recipients.length === 0) return;
  await emitEvent(tx, 'feedback.reporterTold', { ...told, recipients: [...recipients], ...notice });
}
